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
    "spec_gatherer": "planning",
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
}


def get_learning_context(
    project_dir: str | Path,
    phase: str,
    task_context: dict | None = None,
) -> str:
    """Get learning-based prompt augmentation for the given agent phase.

    This function is designed to be called from agent prompt builders.
    It always returns a string (empty on error) and never raises.

    Args:
        project_dir: Path to the project directory
        phase: Agent phase (planning, coding, qa_review, qa_fixing)
        task_context: Optional task context with tags for relevance filtering

    Returns:
        Formatted markdown string to append to agent prompts, or empty string.
    """
    try:
        from .service import LearningLoopService

        service = LearningLoopService(Path(project_dir))
        return service.get_prompt_augmentation(phase, task_context=task_context)
    except Exception as e:
        logger.debug(f"Learning context unavailable: {e}")
        return ""


def context_for_agent(
    project_dir: str | Path,
    agent_type: str,
    task_context: dict | None = None,
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
        return get_learning_context(project_dir, phase, task_context)
    except Exception as e:
        logger.debug(f"Learning context unavailable for {agent_type}: {e}")
        return ""
