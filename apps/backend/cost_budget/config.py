"""The project's spending budget, as the Costs page sets it.

``<project>/.workpilot/cost-budget.json`` holds one budget per project::

    {
      "limit": 50.0,              # USD per period, 0 = no project budget
      "period": "monthly",        # monthly | weekly | total
      "warning_threshold": 0.75,  # share of a limit that warns
      "critical_threshold": 0.9,  # share of a limit that warns louder
      "task_limit": 5.0,          # USD per task, 0 = none
      "on_exceed": "pause",       # pause | warn
      "degrade": false,           # step the model down past the thresholds
      "stall_multiplier": 3.0     # 0 = no stall breaker
    }

Before this file existed the page kept a budget inside ``cost_data.json``
(``budgets[<project path>]``) that nothing enforced; it is still read when the
new file is absent, so a budget set then keeps its amount.

A task can carry its own limit (``budgetUsd`` in its ``task_metadata.json``),
which wins over ``task_limit``: raising it is how a task paused at its budget
goes on.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

CONFIG_FILE = "cost-budget.json"
LEGACY_FILE = "cost_data.json"
PERIODS = ("monthly", "weekly", "total")
ACTIONS = ("pause", "warn")
#: Bigger than this is a typo, not a budget (and keeps the arithmetic finite).
MAX_USD = 1_000_000.0


@dataclass(frozen=True)
class BudgetConfig:
    limit: float = 0.0
    period: str = "monthly"
    warning_threshold: float = 0.75
    critical_threshold: float = 0.9
    task_limit: float = 0.0
    on_exceed: str = "pause"
    degrade: bool = False
    stall_multiplier: float = 3.0

    @property
    def active(self) -> bool:
        return self.limit > 0 or self.task_limit > 0


def _usd(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        return 0.0
    return min(number, MAX_USD)


def _share(value: Any, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return default
    number = float(value)
    return number if math.isfinite(number) and 0 < number < 1 else default


def _read(path: Path) -> Any:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def parse(raw: Any) -> BudgetConfig:
    """A budget from its JSON object; anything unreadable falls to its default."""
    if not isinstance(raw, dict):
        return BudgetConfig()
    period = raw.get("period")
    action = raw.get("on_exceed")
    warning = _share(raw.get("warning_threshold"), 0.75)
    critical = max(_share(raw.get("critical_threshold"), 0.9), warning)
    stall = raw.get("stall_multiplier", 3.0)
    return BudgetConfig(
        limit=_usd(raw.get("limit")),
        period=period if period in PERIODS else "monthly",
        warning_threshold=warning,
        critical_threshold=critical,
        task_limit=_usd(raw.get("task_limit")),
        on_exceed=action if action in ACTIONS else "pause",
        degrade=raw.get("degrade") is True,
        stall_multiplier=_usd(stall) if stall != 0 else 0.0,
    )


def _legacy(root: Path) -> Any:
    data = _read(root / ".workpilot" / LEGACY_FILE)
    budgets = data.get("budgets") if isinstance(data, dict) else None
    if not isinstance(budgets, dict) or not budgets:
        return None
    entry = budgets.get(str(root))
    if entry is None and len(budgets) == 1:
        entry = next(iter(budgets.values()))
    return entry


def load(root: Path) -> BudgetConfig:
    folder = root / ".workpilot"
    if folder.is_symlink():
        return BudgetConfig()
    raw = _read(folder / CONFIG_FILE)
    return parse(raw if raw is not None else _legacy(root))


def task_override(spec_dir: Path) -> float:
    """The task's own limit (``budgetUsd``), 0 when it has none."""
    data = _read(Path(spec_dir) / "task_metadata.json")
    return _usd(data.get("budgetUsd")) if isinstance(data, dict) else 0.0


__all__ = ["BudgetConfig", "CONFIG_FILE", "load", "parse", "task_override"]
