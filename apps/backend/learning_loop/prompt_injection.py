"""
Prompt Injection for the Autonomous Agent Learning Loop.

Provides a simple function to get learning context for agent prompts.

Originally called from the planner, coder and QA agents only — four phases out
of the whole product — which meant every feature outside the build pipeline
re-derived the same lessons on every run. `context_for_agent` below is the
entry point for the rest: it takes the `agent_type` a caller already has,
rather than a build phase it would have to invent.

Always fails gracefully — returns empty string on any error.
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# agent_type -> the pattern phase whose lessons apply to it.
#
# Every value here must be a member of `AGENT_PHASES`, and a test enforces it.
# The first version of this table keyed the non-build agents on "review",
# "research" and "spec" — phases that read well and that nothing writes, since
# `prompts/learning_analyzer.md` offers the model exactly four. The result was
# a feature that looked wired and returned an empty string on every call, for
# every project, forever.
#
# So each row below maps onto work the extractor genuinely mines, and the
# mapping has to be defensible as *the same job*, not merely adjacent:
#
#   review-type agents -> qa_review
#       Both read finished code and judge it against criteria someone else
#       set. A lesson about what the QA reviewer keeps missing is a lesson the
#       PR reviewer needs.
#
#   research- and spec-type agents -> planning
#       Both decide what should be done before anything is written. What the
#       planner learned about this codebase's shape is what an ideation pass
#       is trying to work out.
_PHASE_BY_AGENT: dict[str, str] = {
    # Deciding what to do.
    "planner": "planning",
    "architect": "planning",
    "impact_analyzer": "planning",
    "ideation": "planning",
    "insights": "planning",
    "insight_extractor": "planning",
    "analyzer": "planning",
    "learning_analyzer": "planning",
    "context_mesh_analyzer": "planning",
    "live_companion_analyzer": "planning",
    "spec_writer": "planning",
    "spec_researcher": "planning",
    "spec_self_critique": "planning",
    # Writing it.
    "coder": "coding",
    "merge_resolver": "coding",
    "migration": "coding",
    # Judging what was written.
    "qa_reviewer": "qa_review",
    "pr_reviewer": "qa_review",
    "architecture_reviewer": "qa_review",
    "pr_finding_validator": "qa_review",
    # Repairing it.
    "qa_fixer": "qa_fixing",
    # Seeing it run: the verification loop fixes what the launch shows.
    "verifier": "qa_fixing",
}


#: The agent a build phase speaks for, when the caller names only the phase.
_AGENT_BY_PHASE: dict[str, str] = {
    "planning": "planner",
    "coding": "coder",
    "qa_review": "qa_reviewer",
    "qa_fixing": "qa_fixer",
}


def get_learning_context(
    project_dir: str | Path,
    phase: str,
    task_context: dict | None = None,
    *,
    spec_dir: str | Path | None = None,
    agent: str | None = None,
    kind: str | None = None,
) -> str:
    """Get learning-based prompt augmentation for the given agent phase.

    This function is designed to be called from agent prompt builders.
    It always returns a string (empty on error) and never raises.

    Args:
        project_dir: Path to the project directory
        phase: Agent phase (planning, coding, qa_review, qa_fixing)
        task_context: Optional task context with tags for relevance filtering
        spec_dir: The task's spec directory. With it, the lessons its person
            turned off are left out, and what the prompt carried is recorded
            in ``applied_lessons.json`` for the task panel (``applied``).
        agent: The agent the prompt is for; defaults to the phase's own.
        kind: The task's kind (``bug_fix``, ``feature``…). With it, the
            kind's checkpoints come too, when the project's QA history asks
            for them (``kind_checkpoints``).

    Returns:
        Formatted markdown string to append to agent prompts, or empty string.

    The rules a person adopted from reviews (`review_lessons`) come first and
    apply to every phase: they are the project's word, not a pattern ranked
    by confidence.
    """
    from . import applied, kind_checkpoints
    from .review_lessons import render_rules, rules_for_prompt

    task_dir = Path(spec_dir) if spec_dir is not None else None
    who = agent or _AGENT_BY_PHASE.get(phase, phase)
    off = applied.disabled_ids(task_dir)
    carried: list[applied.Lesson] = []

    rules = rules_for_prompt(project_dir, exclude=off)
    carried += [
        applied.Lesson(id=rule_id, kind="rule", text=rule, agent=who)
        for rule_id, rule in rules
    ]
    try:
        from .service import LearningLoopService

        service = LearningLoopService(Path(project_dir))
        kept = service.applicator.select(phase, task_context=task_context, exclude=off)
        patterns = service.applicator.render(kept)
        carried += [
            applied.Lesson(
                id=p.pattern_id,
                kind="pattern",
                text=p.actionable_instruction,
                agent=who,
                pattern_type=p.pattern_type.value,
                confidence=round(p.confidence, 2),
            )
            for p in kept
        ]
    except Exception as e:
        logger.debug(f"Learning context unavailable: {e}")
        patterns = ""
    checkpoints, seen = kind_checkpoints.checkpoints_for(
        Path(project_dir), kind, who, spec_dir=task_dir
    )
    checkpoints = [c for c in checkpoints if c.id not in off]
    carried += checkpoints
    applied.record(task_dir, carried)
    blocks = (render_rules(rules), patterns, kind_checkpoints.render(checkpoints, seen))
    return "\n".join(part for part in blocks if part)


def context_for_agent(
    project_dir: str | Path,
    agent_type: str,
    task_context: dict | None = None,
    *,
    spec_dir: str | Path | None = None,
    kind: str | None = None,
) -> str:
    """Learning context for any agent, keyed by `agent_type`.

    The phase-keyed `get_learning_context` above stays as it is — the build
    pipeline calls it with phases it genuinely has. This is for everything
    else, which has an `agent_type` in hand and no phase.

    Returns the lessons filed under this agent's phase, or "" when there are
    none — or when no phase applies to it. Never raises.
    """
    try:
        phase = _PHASE_BY_AGENT.get(agent_type)
        if not phase:
            # No defensible phase for this agent_type. Returning nothing is
            # honest; inventing a phase would hand it another role's lessons.
            return ""
        return get_learning_context(
            project_dir,
            phase,
            task_context,
            spec_dir=spec_dir,
            agent=agent_type,
            kind=kind,
        )
    except Exception as e:
        logger.debug(f"Learning context unavailable for {agent_type}: {e}")
        return ""
