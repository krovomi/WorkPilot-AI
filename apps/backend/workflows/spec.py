"""The shape of a declarative workflow.

`cli/build_commands.py` hard-codes the sequence planning → coding → QA in
Python. There is no way to insert a phase, skip one, or run a different
methodology's implementation of one without editing that function. A
`workflow.yaml` makes the sequence data.

The phase vocabulary deliberately extends the one that already exists
(`spec`, `planning`, `coding`, `qa` from `phase_config.DEFAULT_PHASE_MODELS`)
rather than inventing a parallel one, so per-phase model and effort resolution
keeps working unchanged.

Phase fields
------------
``id``          the phase name; drives model/effort lookup via phase_config
``impl``        ``<pack>/<skill>`` — which methodology implements this phase
``min_effort``  pruned below this effort level (default: never pruned)
``hard_gate``   never pruned at any effort. Tests passing is not negotiable.
``always``      never pruned, but not a gate — for near-free phases like observation
``dispatch``    ``subagent-per-task`` | ``fresh-context`` | ``inline``
``when``        ``touches("<globs>")`` — run only when matching files changed;
                ``kind == <kind>`` / ``complexity == <level>`` — run only on a
                task of that kind (`tasks.classify`) or that assessed
                complexity (`spec.complexity`); terms joined by ``and``.
                A fact the build does not know (no kind recorded, no
                assessment) is read as matching: erring towards running a
                conditional phase is the engine's rule everywhere.
``gate``        ``human`` — stop for approval before continuing
``agent``       the AGENT_CONFIGS entry a skill phase runs under, when the
                default for its id is not the right one. Data rather than a
                branch in the runner, for the same reason ``gate`` and
                ``bootstrap`` are declared by their pack.
``roster``      which subagent roster the phase gets, when it is not the one
                its ``agent`` implies. The two are separate questions —
                ``agent`` decides the tool allowlist and whether the phase may
                write, ``roster`` decides which specialists it may dispatch to
                — and binding them meant a read-only audit could only get the
                right specialists by being handed write access.
``fallback``    ``<pack>/<skill>`` played when ``impl`` does not resolve — the
                pack is not installed, the skill is not on disk, or its
                ``requires`` is not met in the target project. This is what
                makes an optional methodology (BMAD) declarable without a hole
                in the profile: the phase is **substituted**, never silently
                dropped, and the profile says so. A fallback that does not
                resolve either is reported by ``validate_impls`` like any
                missing implementation.
``irreversible`` the phase changes something outside the worktree that cannot
                be undone by discarding the branch (a deployment, a data
                migration, a purge). Data for the runner: a later lot pauses
                the build before such a phase and resumes it only on an
                explicit human go. Declared here so a workflow can already say
                it, and so the UI can show it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

__all__ = [
    "EFFORT_ORDER",
    "Phase",
    "Workflow",
    "WorkflowError",
    "load_workflow",
    "effort_at_least",
]

# Ordered weakest to strongest. Mirrors phase_config.THINKING_BUDGET_MAP, which
# is the vocabulary the UI already exposes.
EFFORT_ORDER: tuple[str, ...] = ("none", "low", "medium", "high", "ultrathink")

_DISPATCH = {"subagent-per-task", "fresh-context", "inline"}
_TOUCHES_RE = re.compile(r'^touches\(\s*"(?P<globs>[^"]*)"\s*\)$')
_FACT_RE = re.compile(r"^(?P<field>kind|complexity)\s*==\s*(?P<value>[a-z_]+)$")
#: The values each task fact may be compared to. Closed, so a typo in a
#: workflow is a load error rather than a phase that never runs.
_FACT_VALUES: dict[str, frozenset[str]] = {
    "kind": frozenset(
        {
            "feature",
            "bug_fix",
            "hotfix",
            "investigation",
            "run",
            "refactoring",
            "test",
            "docs",
            "spike",
        }
    ),
    "complexity": frozenset({"simple", "standard", "complex"}),
}


class WorkflowError(Exception):
    """A workflow file is malformed. Fatal: guessing at a broken workflow runs
    the wrong phases, which is worse than not running."""


def effort_at_least(actual: str, minimum: str) -> bool:
    """Whether ``actual`` is at least as strong as ``minimum``."""
    try:
        return EFFORT_ORDER.index(actual) >= EFFORT_ORDER.index(minimum)
    except ValueError as exc:
        raise WorkflowError(
            f"unknown effort level; expected one of {', '.join(EFFORT_ORDER)}"
        ) from exc


@dataclass(frozen=True)
class Phase:
    id: str
    impl: str
    min_effort: str = "none"
    hard_gate: str | None = None
    always: bool = False
    dispatch: str = "inline"
    when_globs: tuple[str, ...] = ()
    # ``((field, value), ...)`` from ``kind == x`` / ``complexity == y``;
    # every term must hold. Empty means no condition on the task.
    when_task: tuple[tuple[str, str], ...] = ()
    gate: str | None = None
    agent: str | None = None
    roster: str | None = None
    fallback: str | None = None
    irreversible: bool = False
    description: str = ""
    # Lenses applied only when the task touches their files, as
    # ``((name, globs), ...)``: ``lenses: {store-readiness: touches("…")}``.
    # Which names exist is the executor's business (`workflows.runner`).
    conditional_lenses: tuple[tuple[str, tuple[str, ...]], ...] = ()

    @property
    def prunable(self) -> bool:
        return not (self.always or self.hard_gate)

    @property
    def pack(self) -> str:
        return self.impl.split("/", 1)[0]

    @property
    def skill(self) -> str:
        return self.impl.split("/", 1)[1] if "/" in self.impl else self.impl

    def with_impl(self, impl: str) -> Phase:
        """The same phase played by another implementation.

        Used by the engine to substitute ``fallback`` for ``impl``: everything
        else about the phase — its id, agent, roster, gates — is unchanged, and
        the result carries no fallback of its own, so a substitution happens
        once.
        """
        return replace(self, impl=impl, fallback=None)


@dataclass(frozen=True)
class Workflow:
    name: str
    phases: tuple[Phase, ...]
    description: str = ""
    path: Path | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def phase(self, phase_id: str) -> Phase | None:
        return next((p for p in self.phases if p.id == phase_id), None)


def _parse_when(raw: Any, phase_id: str) -> tuple[str, ...]:
    """The globs of a ``touches("…")`` condition; the only form a lens takes."""
    globs, facts = _parse_condition(raw, phase_id)
    if facts:
        raise WorkflowError(
            f'phase {phase_id!r}: a lens condition can only be touches("…")'
        )
    return globs


def _parse_condition(
    raw: Any, phase_id: str
) -> tuple[tuple[str, ...], tuple[tuple[str, str], ...]]:
    """``when:`` → (globs, task facts).

    ``touches("a,b")``, ``kind == feature``, ``complexity == complex``, any
    of them joined by ``and``. One ``touches`` at most; a fact named twice
    is a contradiction or a repetition, and refused either way.
    """
    if raw is None:
        return (), ()
    if not isinstance(raw, str):
        raise WorkflowError(f"phase {phase_id!r}: 'when' must be a string")
    globs: tuple[str, ...] = ()
    facts: list[tuple[str, str]] = []
    for term in (t.strip() for t in re.split(r"\s+and\s+", raw.strip())):
        if m := _TOUCHES_RE.match(term):
            if globs:
                raise WorkflowError(f"phase {phase_id!r}: two touches() conditions")
            globs = tuple(g.strip() for g in m.group("globs").split(",") if g.strip())
            continue
        if m := _FACT_RE.match(term):
            field_name, value = m.group("field"), m.group("value")
            if value not in _FACT_VALUES[field_name]:
                raise WorkflowError(
                    f"phase {phase_id!r}: {field_name} == {value!r} — expected one "
                    f"of {', '.join(sorted(_FACT_VALUES[field_name]))}"
                )
            if any(f == field_name for f, _ in facts):
                raise WorkflowError(f"phase {phase_id!r}: {field_name} compared twice")
            facts.append((field_name, value))
            continue
        raise WorkflowError(
            f"phase {phase_id!r}: unsupported condition {term!r}. "
            'The forms are touches("glob,glob"), kind == <kind>, '
            "complexity == <level>, joined by 'and'."
        )
    return globs, tuple(facts)


def _parse_lenses(raw: Any, phase_id: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    if raw is None:
        return ()
    if not isinstance(raw, dict):
        raise WorkflowError(f"phase {phase_id!r}: 'lenses' must be a mapping")
    return tuple(
        (str(name), _parse_when(when, f"{phase_id}.lenses.{name}"))
        for name, when in raw.items()
    )


def _parse_phase(raw: Any, index: int) -> Phase:
    if not isinstance(raw, dict):
        raise WorkflowError(f"phase #{index}: expected a mapping")
    phase_id = raw.get("id")
    if not phase_id:
        raise WorkflowError(f"phase #{index}: missing 'id'")
    impl = raw.get("impl")
    if not impl:
        raise WorkflowError(f"phase {phase_id!r}: missing 'impl'")

    min_effort = str(raw.get("min_effort", "none"))
    if min_effort not in EFFORT_ORDER:
        raise WorkflowError(
            f"phase {phase_id!r}: min_effort {min_effort!r} is not one of "
            f"{', '.join(EFFORT_ORDER)}"
        )
    dispatch = str(raw.get("dispatch", "inline"))
    if dispatch not in _DISPATCH:
        raise WorkflowError(
            f"phase {phase_id!r}: dispatch {dispatch!r} is not one of "
            f"{', '.join(sorted(_DISPATCH))}"
        )
    gate = raw.get("gate")
    if gate not in (None, "human"):
        raise WorkflowError(f"phase {phase_id!r}: gate {gate!r} — only 'human' exists")
    fallback = raw.get("fallback")
    if fallback is not None:
        fallback = str(fallback)
        if "/" not in fallback:
            raise WorkflowError(
                f"phase {phase_id!r}: fallback {fallback!r} must be '<pack>/<skill>'"
            )
        if fallback == str(impl):
            raise WorkflowError(
                f"phase {phase_id!r}: fallback {fallback!r} is the impl itself"
            )
    irreversible = raw.get("irreversible", False)
    if not isinstance(irreversible, bool):
        raise WorkflowError(f"phase {phase_id!r}: 'irreversible' must be a boolean")
    when_globs, when_task = _parse_condition(raw.get("when"), str(phase_id))

    return Phase(
        id=str(phase_id),
        impl=str(impl),
        min_effort=min_effort,
        hard_gate=(str(raw["hard_gate"]) if raw.get("hard_gate") else None),
        always=bool(raw.get("always", False)),
        dispatch=dispatch,
        when_globs=when_globs,
        when_task=when_task,
        gate=gate,
        agent=(str(raw["agent"]) if raw.get("agent") else None),
        roster=(str(raw["roster"]) if raw.get("roster") else None),
        fallback=fallback,
        irreversible=irreversible,
        description=str(raw.get("description", "")),
        conditional_lenses=_parse_lenses(raw.get("lenses"), str(phase_id)),
    )


def load_workflow(path: Path) -> Workflow:
    if not path.is_file():
        raise WorkflowError(f"no workflow at {path}")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        raise WorkflowError(f"{path}: invalid YAML — {exc}") from exc
    if not isinstance(raw, dict):
        raise WorkflowError(f"{path}: expected a mapping at the top level")

    phases_raw = raw.get("phases")
    if not isinstance(phases_raw, list) or not phases_raw:
        raise WorkflowError(f"{path}: 'phases' must be a non-empty list")

    phases = tuple(_parse_phase(p, i) for i, p in enumerate(phases_raw))
    seen: set[str] = set()
    for phase in phases:
        if phase.id in seen:
            raise WorkflowError(f"{path}: duplicate phase id {phase.id!r}")
        seen.add(phase.id)

    return Workflow(
        name=str(raw.get("name") or path.parent.name),
        phases=phases,
        description=str(raw.get("description", "")),
        path=path,
        metadata=raw.get("metadata") or {},
    )
