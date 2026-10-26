"""Goal mode: a task is done when a command says so, within a budget.

See docs/architecture/goal-mode.md.
"""

from .gate import (
    GOAL_ISSUE_TITLE,
    GoalVerdict,
    budget_exceeded,
    evaluate_goal,
    fix_request,
    read_goal,
    record_verdict,
)
from .spec import GOAL_FILENAME, GoalConfigError, GoalSpec, load_goal, parse_goal

__all__ = [
    "GOAL_FILENAME",
    "GOAL_ISSUE_TITLE",
    "GoalConfigError",
    "GoalSpec",
    "GoalVerdict",
    "budget_exceeded",
    "evaluate_goal",
    "fix_request",
    "load_goal",
    "parse_goal",
    "read_goal",
    "record_verdict",
]
