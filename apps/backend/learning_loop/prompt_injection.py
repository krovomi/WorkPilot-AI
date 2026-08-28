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

# agent_type -> the pattern phase whose lessons apply to it. Mirrors
# `agents.subagents.phases.PHASE_ALIASES`, because a lesson is scoped to the
# kind of work an agent does, and that is exactly what the roster keys on.
#
# Deliberately partial: an agent_type absent here reads the "general" bucket
# only. Guessing a phase for it would hand a reviewer lessons mined from
# planning runs, which is worse than handing it none.
_PHASE_BY_AGENT: dict[str, str] = {
    "planner": "planning",
    "architect": "planning",
    "impact_analyzer": "planning",
    "coder": "coding",
    "qa_reviewer": "qa_review",
    "qa_fixer": "qa_fixing",
    "pr_reviewer": "review",
    "architecture_reviewer": "review",
    "pr_finding_validator": "review",
    "ideation": "research",
    "insights": "research",
    "insight_extractor": "research",
    "analyzer": "research",
    "learning_analyzer": "research",
    "spec_writer": "spec",
    "spec_gatherer": "spec",
}

# Patterns filed under this phase are not tied to one kind of work, so every
# agent reads them. The extractor never assigns it today; it exists so a
# human-promoted, project-wide lesson has somewhere to live that does not
# require picking a phase for it.
GENERAL_PHASE = "general"


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

    Returns the agent's own phase lessons plus the general bucket, or "" when
    there is nothing to say. Never raises.
    """
    try:
        phase = _PHASE_BY_AGENT.get(agent_type)
        chunks = []
        if phase:
            chunks.append(get_learning_context(project_dir, phase, task_context))
        chunks.append(get_learning_context(project_dir, GENERAL_PHASE, task_context))
        return "\n".join(c for c in chunks if c.strip())
    except Exception as e:
        logger.debug(f"Learning context unavailable for {agent_type}: {e}")
        return ""
