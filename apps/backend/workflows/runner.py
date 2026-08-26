"""Executing the phases a resolved profile keeps.

Until now the engine resolved a profile and executed three of its eleven
phases: the deterministic gates, `observe`, and `qa` — which it could only
*remove*. `planning` and `coding` were an internal sequence inside
`run_autonomous_agent`, and the six skill-backed phases (`brainstorm`, `spec`,
`review`, `adversarial-review`, `spec-conformance`, `verify`) were declared and
never run at all. `workflow.yaml` was a plan the build did not follow.

This module is the missing half. It runs a phase whose implementation is a
skill rather than WorkPilot Python: it loads the skill's procedure, hands it to
an agent session with the task's context, and writes what comes back where a
human — and the next phase — can read it.

What a skill phase is
---------------------
A `SKILL.md` body is a procedure written for a model. Running one means
starting a session, giving it that procedure plus enough context to apply it,
and keeping the result. That is all a skill phase is. It deliberately does not
get its own agent loop: the phases that need one (`planning`, `coding`, `qa`)
already have WorkPilot implementations, and those stay exactly where they are.

Dispatch is finally read
------------------------
`ResolvedPhase.dispatch` existed, was resolved, was degraded by provider — and
nothing ever looked at it. Here it decides three observable things:

``fresh-context``     the session inherits nothing. In particular it does not
                      resume the transcript a pending ``AUTO_CLAUDE_RESUME_SESSION_ID``
                      points at, which is the whole point of asking a reviewer
                      for an opinion: a reader carrying the writer's reasoning
                      is not a second opinion.
``subagent-per-task`` the phase may dispatch to the subagent roster.
``sequential-reset``  it may not — the provider has no subagents, so the roster
                      is suppressed rather than handed over to be ignored.
``inline``            the default: same session semantics as the rest of the
                      build.

Failure policy
--------------
A phase reports; it does not abort. Everything here is caught and turned into a
`PhaseOutcome`, for the same reason the gates are: a build that produced working
code must not be reported as failed because a review pass could not start. What
must never happen is a phase silently counting as done — an outcome that could
not run says so, and `succeeded` is None rather than True.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

__all__ = [
    "BuiltinPlan",
    "builtin_plan",
    "effort_preamble",
    "PhaseContext",
    "PhaseOutcome",
    "PhaseRun",
    "BUILTIN_EXECUTORS",
    "CONFIG_PHASE",
    "SKILL_PHASE_AGENTS",
    "find_skill_body",
    "phases_between",
    "run_skill_phase",
    "run_skill_phases",
    "subagents_allowed",
    "fresh_context",
]

# Phases WorkPilot executes itself, by **phase id** rather than by `impl`.
#
# That distinction is the whole point of the file being declarative, and it is
# easy to get backwards. `coding` names `superpowers/test-driven-development`:
# the skill is the *methodology*, the coder loop is the *executor*. Keying this
# set on the impl string would mean the day someone swaps TDD for another
# methodology, the coding phase stops being recognised as built in and the
# runner tries to execute it as a one-shot session — losing the entire coder
# loop to a one-line edit in a YAML file.
#
# So: these three ids are executed by `run_autonomous_agent` and
# `run_qa_validation_loop`, whatever methodology they name, and the methodology
# they name is handed to that executor rather than replacing it.
BUILTIN_EXECUTORS = frozenset({"planning", "coding", "qa"})

# Packs whose phases are executed by another part of the engine: impeccable by
# `gates.run_deterministic_gates`, task-observer by `learning_loop.observe`.
_ELSEWHERE = frozenset({"impeccable", "task-observer"})

# A workflow phase id -> the phase_config vocabulary it resolves model and
# effort under. `phase_config` knows four phases; the workflow declares eleven.
# Rather than invent a fifth config phase per new workflow phase — which would
# mean a new column in every model selector in the UI — each phase says which
# of the four it is *paid for as*. A reviewer is a QA cost; a brainstorm is a
# spec cost.
CONFIG_PHASE = {
    "brainstorm": "spec",
    "spec": "spec",
    "planning": "planning",
    "coding": "coding",
    "review": "qa",
    "qa": "qa",
    "adversarial-review": "qa",
    "spec-conformance": "qa",
    "verify": "qa",
}
_DEFAULT_CONFIG_PHASE = "coding"

# The AGENT_CONFIGS entry a skill phase runs under, which decides its tool
# allowlist and whether it is read-only. Reviewers get `pr_reviewer`, which
# `create_client` puts in permission_mode "plan" — a reviewer that can edit the
# code it is reviewing is not reviewing it.
SKILL_PHASE_AGENTS = {
    "brainstorm": "spec_critic",
    "spec": "spec_writer",
    "review": "pr_reviewer",
    "adversarial-review": "pr_reviewer",
    "spec-conformance": "spec_validation",
    "verify": "qa_reviewer",
}
_DEFAULT_AGENT = "analyzer"

# Where a phase's output lands, relative to the spec directory.
OUTPUT_DIRNAME = "workflow"


def subagents_allowed(dispatch: str) -> bool:
    """Whether a phase running under ``dispatch`` may use the subagent roster.

    ``sequential-reset`` is the degraded form of ``subagent-per-task`` on a
    provider with none: the phase still runs, with the same context isolation,
    without the parallel dispatch. Handing that provider a roster it will
    ignore is how the old silent fallback looked from the inside.
    """
    return dispatch != "sequential-reset"


def fresh_context(dispatch: str) -> bool:
    """Whether this phase must start from nothing."""
    return dispatch == "fresh-context"


@dataclass
class PhaseContext:
    """Everything a phase needs to run, gathered once by the caller."""

    project_dir: Path
    spec_dir: Path
    model: str
    repo_root: Path
    effort: str = "medium"
    verbose: bool = False
    changed_files: list[str] | None = None
    task_logger: object | None = None


@dataclass(frozen=True)
class PhaseOutcome:
    phase_id: str
    impl: str
    dispatch: str
    succeeded: bool | None
    """None when the phase could not run. Never True on absent evidence."""
    detail: str = ""
    output_path: Path | None = None

    def describe(self) -> str:
        if self.succeeded is None:
            return f"  ?  {self.phase_id:<19} could not run ({self.detail})"
        mark = "✓" if self.succeeded else "✗"
        suffix = f" [{self.dispatch}]" if self.dispatch != "inline" else ""
        tail = f" — {self.detail}" if self.detail else ""
        return f"  {mark}  {self.phase_id:<19} {self.impl}{suffix}{tail}"


@dataclass
class PhaseRun:
    outcomes: list[PhaseOutcome] = field(default_factory=list)

    @property
    def ran(self) -> bool:
        return any(o.succeeded is not None for o in self.outcomes)

    def describe(self) -> str:
        if not self.outcomes:
            return ""
        return "\n".join(["Workflow phases:", *(o.describe() for o in self.outcomes)])


def phases_between(profile, *, after: str | None, before: str | None) -> list:
    """The resolved skill phases sitting in a window of the declared order.

    The window is expressed by phase id rather than by index so that inserting
    a phase into `workflow.yaml` moves it automatically: a new phase declared
    between `coding` and `qa` is picked up by the call that runs that window,
    with no Python change. That is the point of the file being data.

    The boundaries are looked up in the **declared** order, not in what
    survived pruning. A window bounded by a phase the effort level dropped —
    `before="qa"` on a build with no QA pass — would otherwise widen to the end
    of the list and run the phases the *next* window is responsible for, twice.
    A pruned boundary still marks its position.

    Phases another executor owns — the WorkPilot builtins, the deterministic
    gates, the observer — are stepped over here rather than filtered by the
    caller, so there is one list of who runs what.
    """
    declared = getattr(profile, "declared", ()) or tuple(r.id for r in profile.run)

    def _at(phase_id: str | None, fallback: int) -> int:
        if phase_id is None:
            return fallback
        try:
            return declared.index(phase_id)
        except ValueError:
            return fallback

    start = _at(after, -1)
    stop = _at(before, len(declared))
    if start >= stop:
        return []

    out = []
    for resolved in profile.run:
        position = _at(resolved.id, -1)
        if not (start < position < stop):
            continue
        if resolved.id in BUILTIN_EXECUTORS:
            continue
        if resolved.phase.pack in _ELSEWHERE:
            continue
        out.append(resolved)
    return out


def find_skill_body(repo_root: Path, pack: str, skill: str) -> tuple[str, Path] | None:
    """The procedure text of a skill, and where it was read from.

    The built output is preferred over the source. `.agents/skills/` is what
    `skills-cli build` emits after resolving variants and dropping skills whose
    `requires` are not satisfied — so reading it means a phase never runs a
    procedure the resolver already decided this checkout cannot support. The
    source tree is the fallback for a checkout that has not been built.
    """
    from skills_registry.frontmatter import parse_frontmatter

    candidates = [
        repo_root / ".agents" / "skills" / skill / "SKILL.md",
        repo_root / "skills" / pack / skill / "SKILL.md",
    ]
    for path in candidates:
        try:
            if not path.is_file():
                continue
            _meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            logger.debug("could not read %s: %s", path, exc)
            continue
        if body.strip():
            return body, path
    return None


def _build_prompt(resolved, body: str, ctx: PhaseContext) -> str:
    """The procedure, plus the minimum context needed to apply it.

    The effort level is injected rather than branched on inside the skill. A
    skill body full of "if effort is high, also…" is a skill that only works on
    the harness that exposes the variable; the engine already knows the level,
    so it says it.
    """
    phase = resolved.phase
    lines = [
        f"# Workflow phase: {phase.id}",
        "",
        f"You are executing the `{phase.id}` phase of the `{ctx.spec_dir.name}` "
        f"task, following the procedure below.",
        "",
        f"EFFORT: {ctx.effort}",
        f"DISPATCH: {resolved.dispatch}",
    ]
    if resolved.degraded_from:
        lines.append(
            f"NOTE: this phase asked for `{resolved.degraded_from}` and was "
            f"degraded to `{resolved.dispatch}` — {resolved.reason}."
        )
    lines += [
        f"SPEC DIRECTORY: {ctx.spec_dir}",
        f"PROJECT DIRECTORY: {ctx.project_dir}",
    ]
    if ctx.changed_files:
        shown = ctx.changed_files[:60]
        lines.append(f"FILES CHANGED BY THIS TASK ({len(ctx.changed_files)}):")
        lines += [f"  - {p}" for p in shown]
        if len(ctx.changed_files) > len(shown):
            lines.append(f"  … and {len(ctx.changed_files) - len(shown)} more")
    if phase.description:
        lines += ["", f"WHY THIS PHASE EXISTS: {phase.description.strip()}"]
    lines += [
        "",
        "---",
        "",
        "## Procedure",
        "",
        body.strip(),
        "",
        "---",
        "",
        "## Reporting",
        "",
        "End your turn with a written result: what you did, what you found, and "
        "whether the phase's objective was met. If the procedure asks you to "
        "produce a document, write the file and say where it is.",
        "",
        "If your procedure ran the test suite, state the outcome on a line of "
        "its own, exactly `Tests: pass` or `Tests: fail`. That line is read by "
        "the workflow's hard gate; without it the gate records the result as "
        "unknown, which is neither a pass nor a failure.",
    ]
    return "\n".join(lines)


def _write_output(ctx: PhaseContext, phase_id: str, text: str) -> Path | None:
    try:
        out_dir = ctx.spec_dir / OUTPUT_DIRNAME
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{phase_id}.md"
        path.write_text(text, encoding="utf-8")
        return path
    except OSError as exc:
        logger.debug("could not persist %s output: %s", phase_id, exc)
        return None


async def run_skill_phase(resolved, ctx: PhaseContext) -> PhaseOutcome:
    """Run one skill-backed phase. Never raises."""
    phase = resolved.phase
    impl = phase.impl

    found = find_skill_body(ctx.repo_root, phase.pack, phase.skill)
    if found is None:
        return PhaseOutcome(
            phase.id,
            impl,
            resolved.dispatch,
            None,
            detail=(
                f"no SKILL.md for {impl} — run "
                f"`pnpm run skills:bootstrap --pack {phase.pack}`"
            ),
        )
    body, source = found
    logger.debug("phase %s: procedure from %s", phase.id, source)

    try:
        from agents.session import run_agent_session
        from core.client import create_agent_client
        from phase_config import get_phase_model, get_phase_thinking_budget
        from task_logger import LogPhase
    except ImportError as exc:  # pragma: no cover - import-time environment
        return PhaseOutcome(
            phase.id, impl, resolved.dispatch, None, detail=f"unavailable: {exc}"
        )

    config_phase = CONFIG_PHASE.get(phase.id, _DEFAULT_CONFIG_PHASE)
    agent_type = phase.agent or SKILL_PHASE_AGENTS.get(phase.id, _DEFAULT_AGENT)

    # `fresh-context` means exactly this: the session must not rehydrate a
    # transcript. The resume id is a process-wide env var consumed inside
    # create_client, so it is lifted for the duration of the call and put back
    # — the coder loop's own resume must survive a review pass running between
    # two of its iterations.
    stashed = None
    if fresh_context(resolved.dispatch):
        stashed = os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)

    try:
        client = create_agent_client(
            project_dir=ctx.project_dir,
            spec_dir=ctx.spec_dir,
            model=get_phase_model(ctx.spec_dir, config_phase, ctx.model),
            agent_type=agent_type,
            max_thinking_tokens=get_phase_thinking_budget(ctx.spec_dir, config_phase),
            use_subagents=subagents_allowed(resolved.dispatch),
        )
        prompt = _build_prompt(resolved, body, ctx)
        async with client:
            status, response, _err = await run_agent_session(
                client,
                prompt,
                ctx.spec_dir,
                ctx.verbose,
                phase=LogPhase.CODING,
            )
    except Exception as exc:  # noqa: BLE001 - a phase reports, it does not abort
        logger.warning("phase %s failed to run: %s", phase.id, exc)
        return PhaseOutcome(
            phase.id, impl, resolved.dispatch, None, detail=str(exc)[:200]
        )
    finally:
        if stashed is not None:
            os.environ["AUTO_CLAUDE_RESUME_SESSION_ID"] = stashed

    output_path = _write_output(ctx, phase.id, response or "")
    if status == "error":
        return PhaseOutcome(
            phase.id,
            impl,
            resolved.dispatch,
            False,
            detail="the session ended in an error",
            output_path=output_path,
        )
    return PhaseOutcome(
        phase.id,
        impl,
        resolved.dispatch,
        True,
        detail=(f"→ {output_path.name}" if output_path else ""),
        output_path=output_path,
    )


async def run_skill_phases(
    profile,
    ctx: PhaseContext,
    *,
    after: str | None = None,
    before: str | None = None,
) -> PhaseRun:
    """Run every skill phase the profile kept in a window of the declared order.

    Returns what happened. Never raises, and never stops early on a failure: a
    review that could not start is not a reason to skip the conformance check
    that follows it.
    """
    run = PhaseRun()
    try:
        window = phases_between(profile, after=after, before=before)
    except Exception as exc:  # noqa: BLE001 - resolution never blocks a build
        logger.warning("could not select workflow phases: %s", exc)
        return run

    for resolved in window:
        run.outcomes.append(await run_skill_phase(resolved, ctx))
    return run


# ---------------------------------------------------------------------------
# The two phases WorkPilot implements inside `run_autonomous_agent`
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BuiltinPlan:
    """What the resolved profile says about `planning` and `coding`.

    These two are the pair the coder loop runs as one internal sequence, which
    is why they need a decision object rather than a phase runner: the loop
    owns the transition between them and always has. What it did not own was
    the *decision* — it planned and coded the same way at every effort level,
    on every provider, whatever `workflow.yaml` said. This is that decision,
    made once, by the engine, and handed down.
    """

    planning_runs: bool
    coding_dispatch: str
    effort: str
    coding_degraded_from: str | None = None
    degradation_reason: str = ""
    impls: dict[str, str] = field(default_factory=dict)
    """Phase id -> the ``<pack>/<skill>`` methodology it declares.

    `coding` declares `superpowers/test-driven-development` and nothing ever
    loaded it: the phase named a methodology, the coder loop ran the same way
    regardless, and swapping the `impl:` line changed nothing at all. Carrying
    it here is what makes "the methodologies become interchangeable phase
    implementations" true of the two phases that do the actual work.
    """

    @property
    def use_subagents(self) -> bool:
        return subagents_allowed(self.coding_dispatch)

    def describe(self) -> str:
        parts = [f"coding dispatch: {self.coding_dispatch}"]
        if self.coding_degraded_from:
            parts.append(
                f"degraded from {self.coding_degraded_from} ({self.degradation_reason})"
            )
        if not self.planning_runs:
            parts.append("planning pruned by effort")
        return f"Workflow: {', '.join(parts)}"


_DEFAULT_PLAN = BuiltinPlan(
    planning_runs=True, coding_dispatch="inline", effort="medium"
)


def builtin_plan(profile) -> BuiltinPlan:
    """Read the profile's verdict on the two built-in phases.

    Returns the previous behaviour unchanged when there is no profile, which is
    what the engine being switched off has to mean.
    """
    if profile is None:
        return _DEFAULT_PLAN
    try:
        coding = next((r for r in profile.run if r.id == "coding"), None)
        return BuiltinPlan(
            planning_runs=profile.will_run("planning"),
            coding_dispatch=(coding.dispatch if coding else "inline"),
            effort=profile.effort,
            coding_degraded_from=(coding.degraded_from if coding else None),
            degradation_reason=(coding.reason if coding else ""),
            impls={
                r.id: r.phase.impl for r in profile.run if r.id in BUILTIN_EXECUTORS
            },
        )
    except Exception as exc:  # noqa: BLE001 - never block a build
        logger.warning("could not read the workflow plan, using defaults: %s", exc)
        return _DEFAULT_PLAN


def effort_preamble(
    plan: BuiltinPlan, phase_id: str, repo_root: Path | None = None
) -> str:
    """What the engine injects into a built-in phase's prompt.

    Two things the coder loop never had.

    **The effort level.** Chantier 4's portable answer to effort sensitivity:
    the engine states the level rather than the prompt template branching on a
    variable only some harnesses expose. So a `low` build and an `ultrathink`
    build differ in what the model is told, not only in how many phases run.

    **The methodology the phase declares.** As a path, not as inlined text.
    The TDD skill is ten kilobytes and the coder loop starts a fresh session
    per subtask, so pasting the body in would be a four-figure token bill on
    every iteration of every build to say something the model can read on
    demand — which is what skills are for. Naming the file costs a line and
    lets the phase's `impl:` finally mean something.
    """
    lines = [f"EFFORT: {plan.effort}", f"WORKFLOW PHASE: {phase_id}"]

    impl = plan.impls.get(phase_id)
    if impl and not impl.startswith("workpilot/"):
        lines.append(f"METHODOLOGY: {impl}")
        located = _locate_skill(repo_root, impl) if repo_root else None
        if located is not None:
            lines.append(
                f"Read `{located}` before you start and follow it. It is the "
                f"procedure this phase is defined by."
            )

    if phase_id == "coding" and plan.coding_dispatch != "inline":
        lines.append(f"DISPATCH: {plan.coding_dispatch}")
        if plan.coding_degraded_from:
            lines.append(
                f"NOTE: `{plan.coding_degraded_from}` was requested and is not "
                f"available — {plan.degradation_reason}. Work through the "
                f"subtasks one at a time; do not attempt to dispatch them."
            )
    return "\n".join(lines)


def _locate_skill(repo_root: Path, impl: str) -> str | None:
    """The on-disk path of a `<pack>/<skill>` impl, relative to the repo.

    None when the pack has not been vendored: pointing a build at a file that
    is not there wastes a tool call and teaches the model to distrust the
    instruction. A missing methodology is silent here and reported by
    `validate_impls` up front, which is where a human can act on it.
    """
    pack, _, skill = impl.partition("/")
    for candidate in (
        Path(".agents") / "skills" / skill / "SKILL.md",
        Path("skills") / pack / skill / "SKILL.md",
    ):
        try:
            if (repo_root / candidate).is_file():
                return candidate.as_posix()
        except OSError:
            continue
    return None
