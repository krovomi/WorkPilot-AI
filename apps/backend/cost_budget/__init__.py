"""Cost budgets enforced while a task runs (#355).

The Costs page sets them (``.workpilot/cost-budget.json``), every agent
session's spend is read from the ledger all providers write, and the build
reads them before each session: thresholds announced in the task's log, a
paused build at 100 %, an optional step down to a lighter model, and a stall
breaker for a task that spends without completing subtasks.
Design: ``docs/architecture/cost-budgets.md``.
"""

from .config import BudgetConfig, load, parse, task_override
from .degrade import budget_model, step_down
from .guard import (
    PAUSE_REASON,
    STALL_REASON,
    Evaluation,
    Limit,
    check_before_session,
    degrade_steps,
    evaluate,
)

__all__ = [
    "PAUSE_REASON",
    "STALL_REASON",
    "BudgetConfig",
    "Evaluation",
    "Limit",
    "budget_model",
    "check_before_session",
    "degrade_steps",
    "evaluate",
    "load",
    "parse",
    "step_down",
    "task_override",
]
