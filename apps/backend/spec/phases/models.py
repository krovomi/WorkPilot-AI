"""
Phase Models and Constants
===========================

Data structures and constants for phase execution.
"""

from dataclasses import dataclass, field


@dataclass
class PhaseResult:
    """Result of a phase execution."""

    phase: str
    success: bool
    output_files: list[str]
    errors: list[str]
    retries: int
    # What the phase stood in for: a placeholder written because the agent
    # produced nothing. The phase still succeeds — the pipeline moves on — but
    # the orchestrator logs each one, so "nothing to report" and "nothing was
    # done" no longer read the same.
    warnings: list[str] = field(default_factory=list)


def phase_notes(phase_name: str, result: PhaseResult) -> list[str]:
    """The lines a *successful* phase owes the task log.

    Its warnings (a placeholder it wrote) and its errors (the attempts that
    failed before it succeeded, or before it gave up and stood something in).
    Both used to be dropped on success, so a phase that did nothing reported
    exactly what a phase that did its job reports.
    """
    return [f"{phase_name}: {note}" for note in (*result.warnings, *result.errors)]


# Maximum retry attempts for phase execution
MAX_RETRIES = 3
