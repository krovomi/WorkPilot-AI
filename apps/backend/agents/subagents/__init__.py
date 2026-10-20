"""Composing the subagent roster for a run.

Three layers, in order, each able to override the one before it:

1. **Phase defaults** — the generic roster for planner / coder / QA.
2. **Language overlays** — what the detected stack changes about those roles.
   A `test-runner` that knows `pytest -x` and `vitest run` beats one that has
   to rediscover the framework every time.
3. **The mobile overlay** — what a phone application changes, which is a
   different axis from language: Flutter is Dart, Expo is TypeScript, MAUI is
   C#, and all three need a device run and a store audit that no language
   overlay describes. Applied after the language ones so its build commands are
   the last word on a project that is both.
4. **Caller-supplied agents** — always win. That was the contract of the three
   `merge_with_user_agents` functions this module replaces, and it is preserved
   exactly.

An overlay specialises the roster a phase already has; it does not give one to
a phase that has none. A `solo` call (a commit message, an archify model, a PR
orchestrator that brings its own specialists) stays empty on a phone project
too: the mobile specialists are for the phases that build, review or verify it.

The roster is capped, and the cap counts everything the parent pays for —
the caller's agents included. Three to five concurrent subagents is where the
parallelism still pays; past seven, reconciling the summaries costs more than
it saves. When the cap bites, generic phase defaults are dropped before
specialised or caller-supplied ones — the specific entry is the one carrying
information the parent does not already have. A roster made only of entries
the caller named can stay above the cap: each one was a decision.

Providers that cannot run subagents get ``None``, not a roster nobody reads.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from project.stack import detect_languages

from .languages import LanguageOverlay, overlays_for
from .mobile import overlay_for as mobile_overlay_for
from .phases import PHASE_ALIASES, phase_defaults, sdk_available

logger = logging.getLogger(__name__)

__all__ = ["resolve", "merge_with_user_agents", "detect_languages", "MAX_ROSTER"]

MAX_ROSTER = 7

#: The roles that run the project's tests, and so learn its commands from the
#: overlays. One since lot L11: the QA roster (`qa_reviewer`, `qa_fixer`,
#: `verifier`) carried a `qa-test-evidence` that was the board's `test-runner`
#: under another prompt, and it used to rediscover the framework on every QA
#: pass the build's runner had already been told about.
_TEST_ROLES = ("test-runner",)


def _specialise_test_runner(
    base: Any, overlays: list[LanguageOverlay], role: str = "test-runner"
) -> Any:
    """Fold concrete commands into the prompt of a role that runs the tests."""
    if not overlays or base is None:
        return base

    lines = ["", "## This project's stack", ""]
    for overlay in overlays:
        lines.append(f"### {overlay.language}")
        if overlay.test_commands:
            lines.append("Commands, most useful first:")
            lines.extend(f"  {cmd}" for cmd in overlay.test_commands)
        if overlay.notes:
            lines.append(f"Watch out: {overlay.notes}")
        lines.append("")
    lines.append(
        "Detection was done from the files on disk. If what you find "
        "contradicts the above, trust the repository and say so in your report."
    )

    try:
        from claude_agent_sdk import AgentDefinition

        return AgentDefinition(
            description=base.description,
            prompt=base.prompt + "\n" + "\n".join(lines),
            tools=base.tools,
            model=getattr(base, "model", None) or "inherit",
        )
    except Exception as exc:  # never break the roster
        # Warning, not debug: the run continues with a generic test-runner,
        # which still works but has to rediscover the framework every time.
        # A silent downgrade is how you end up wondering why the roster stopped
        # helping.
        logger.warning(
            "could not specialise %s, falling back to the generic prompt: %s",
            role,
            exc,
        )
        return base


def _as_language_overlay(mobile: Any) -> LanguageOverlay:
    """The mobile overlay, in the shape `_specialise_test_runner` already reads."""
    return LanguageOverlay(
        language=f"{mobile.framework} ({'/'.join(mobile.platforms)})",
        test_commands=list(mobile.test_commands) + list(mobile.build_commands),
        extra_agents=dict(mobile.extra_agents),
        notes=mobile.notes,
    )


def _apply_cap(roster: dict[str, Any], protected: set[str]) -> dict[str, Any]:
    """Trim to MAX_ROSTER, dropping unprotected generic entries first."""
    if len(roster) <= MAX_ROSTER:
        return roster
    droppable = [name for name in roster if name not in protected]
    # Deterministic: alphabetical, so the same project always gets the same
    # roster rather than one that shifts with dict ordering.
    for name in sorted(droppable):
        if len(roster) <= MAX_ROSTER:
            break
        logger.debug("subagent roster over cap; dropping %s", name)
        del roster[name]
    return roster


def resolve(
    agent_type: str,
    project_dir: Path | str | None = None,
    user_agents: dict[str, Any] | None = None,
    provider: str | None = None,
    roster_name: str | None = None,
) -> dict[str, Any] | None:
    """The subagent roster for one run, or ``None`` when there should be none.

    ``roster_name`` overrides the phase the alias table would pick. It exists so a
    workflow phase can choose its specialists independently of the AGENT_CONFIGS
    entry that decides its permissions — the two answer different questions, and
    binding them together meant a read-only audit could only get the right
    subagents by being given write access.
    """
    if provider:
        try:
            from skills_registry.providers import get_provider_capabilities

            if not get_provider_capabilities(provider).supports_subagents:
                logger.debug("provider %r runs no subagents; roster omitted", provider)
                return None
        except Exception as exc:  # capability lookup must not break a run
            logger.debug("provider capability lookup failed: %s", exc)

    if not sdk_available():
        # Without the SDK there are no AgentDefinitions to build, but a caller
        # that passed its own dict still means it.
        return user_agents or None

    roster: dict[str, Any] = phase_defaults(agent_type, roster_name)
    # Read before any overlay adds to it: an empty phase roster is a decision
    # (`solo`), and an overlay specialises a roster, it does not start one.
    phase_has_roster = bool(roster)

    overlays = overlays_for(detect_languages(project_dir))
    mobile = mobile_overlay_for(project_dir)
    if mobile:
        # The mobile overlay speaks the same LanguageOverlay shape on purpose,
        # so `_specialise_test_runner` folds its commands in without a second
        # code path. Appended last: on a Flutter or MAUI project both fire, and
        # the platform commands are the ones that actually build the artefact.
        overlays = [*overlays, _as_language_overlay(mobile)]

    if overlays:
        for role in _TEST_ROLES:
            if role in roster:
                roster[role] = _specialise_test_runner(roster[role], overlays, role)
        if phase_has_roster:
            for overlay in overlays:
                roster.update(overlay.extra_agents)

    if user_agents:
        roster.update(user_agents)  # caller wins, always

    # The cap runs on what the parent will actually carry, the caller's agents
    # included — applied before the merge, it let a PR orchestrator's six
    # specialists sit on top of a full roster. Nothing the caller named is
    # dropped, and neither is a mobile specialist: it is the only entry that
    # knows the project is a phone app, and the cap exists to shed the entries
    # that carry nothing the parent lacks.
    protected = set(_TEST_ROLES) | set(user_agents or {})
    if mobile and phase_has_roster:
        protected |= set(mobile.extra_agents)
    roster = _apply_cap(roster, protected)

    return roster or None


def merge_with_user_agents(
    user_agents: dict[str, Any] | None,
    agent_type: str = "coder",
    project_dir: Path | str | None = None,
) -> dict[str, Any] | None:
    """Backwards-compatible entry point for the pre-registry call sites."""
    return resolve(agent_type, project_dir=project_dir, user_agents=user_agents)
