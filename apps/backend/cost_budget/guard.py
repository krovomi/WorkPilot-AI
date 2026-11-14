"""The budget read before every agent session of a task.

Two limits, each optional: the task's (``budgetUsd`` of the task, else the
project's ``task_limit``) and the project's for its period (``limit``). Each
is ``ok``, then ``warning`` past ``warning_threshold``, ``critical`` past
``critical_threshold`` and ``exceeded`` at 100 %.

- Each threshold is written once to the task's log (``budget_state.json`` in
  the spec directory remembers which ones were), so the person reading the
  card sees the spend climb before anything stops.
- ``exceeded`` with ``on_exceed: pause`` pauses the build through the pause
  store everyone reads (``foundation.pause_state``, reason ``budget``): the
  card shows why, and the build goes on from the same checkpoint once the
  limit is raised. Nothing is lost and nothing is killed mid-session: the
  check sits between sessions, never inside one.
- The stall breaker, on once a budget is set: once a task has completed subtasks, spending
  ``stall_multiplier`` times its average cost per completed subtask with none
  completed since pauses it too (reason ``budget_stall``), whatever its
  limits. A resume gives it a fresh allowance.

The check is skipped when no budget is set: a project that set none sees no
change. It reads the ledger every provider writes (``spend.py``), so it holds
for every provider and harness; a session priced at 0 for want of a price
makes the spend a floor, and the message says so.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from foundation.pause_state import write_pause_state

from . import config as budget_config
from .spend import Spend, project_root, project_spend, task_rows, task_spend

logger = logging.getLogger(__name__)

STATE_FILE = "budget_state.json"
PAUSE_REASON = "budget"
STALL_REASON = "budget_stall"
#: Below this, a "stall" is noise (a retry, a short session).
MIN_STALL_USD = 0.5
LEVELS = ("ok", "warning", "critical", "exceeded")


@dataclass(frozen=True)
class Limit:
    scope: str  # "task" | "project"
    spent: Spend
    limit: float
    period: str = ""

    @property
    def percent(self) -> float:
        return round(self.spent.usd / self.limit * 100, 1) if self.limit else 0.0

    def level(self, cfg: budget_config.BudgetConfig) -> str:
        if self.spent.usd >= self.limit:
            return "exceeded"
        if self.spent.usd >= self.limit * cfg.critical_threshold:
            return "critical"
        if self.spent.usd >= self.limit * cfg.warning_threshold:
            return "warning"
        return "ok"

    def to_dict(self, cfg: budget_config.BudgetConfig) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "spentUsd": self.spent.usd,
            "limitUsd": self.limit,
            "percent": self.percent,
            "level": self.level(cfg),
            "complete": self.spent.complete,
            "period": self.period,
        }


@dataclass(frozen=True)
class Evaluation:
    cfg: budget_config.BudgetConfig
    limits: tuple[Limit, ...]

    def worst(self) -> str:
        levels = [lim.level(self.cfg) for lim in self.limits]
        return max(levels, key=LEVELS.index) if levels else "ok"

    def exceeded(self) -> Limit | None:
        return next(
            (lim for lim in self.limits if lim.level(self.cfg) == "exceeded"), None
        )


def evaluate(spec_dir: Path) -> Evaluation | None:
    """The task's limits as they stand; None when the project sets no budget."""
    root = project_root(spec_dir)
    if root is None:
        return None
    cfg = budget_config.load(root)
    override = max(budget_config.task_override(d) for d in spec_dirs(spec_dir))
    if not cfg.active and not override:
        return None
    task_limit = override or cfg.task_limit
    limits: list[Limit] = []
    if task_limit > 0:
        limits.append(Limit("task", task_spend(root, Path(spec_dir).name), task_limit))
    if cfg.limit > 0:
        limits.append(
            Limit("project", project_spend(root, cfg.period), cfg.limit, cfg.period)
        )
    return Evaluation(cfg, tuple(limits))


def degrade_steps(spec_dir: Path | None) -> int:
    """How many tiers ``degrade`` steps the model down: 0, 1 or 2."""
    if spec_dir is None:
        return 0
    try:
        found = evaluate(spec_dir)
    except OSError:
        return 0
    if found is None or not found.cfg.degrade:
        return 0
    worst = found.worst()
    return 2 if worst in ("critical", "exceeded") else 1 if worst == "warning" else 0


# ---------------------------------------------------------------------------
# State kept in the spec directory: thresholds announced, stall mark
# ---------------------------------------------------------------------------


def _state_path(spec_dir: Path) -> Path:
    return Path(spec_dir) / STATE_FILE


def _load_state(spec_dir: Path) -> dict[str, Any]:
    path = _state_path(spec_dir)
    if path.is_symlink():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save_state(spec_dir: Path, state: dict[str, Any]) -> None:
    path = _state_path(spec_dir)
    if path.is_symlink():
        return
    try:
        path.write_text(json.dumps(state, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.warning("budget state not written: %s", exc)


def _key(limit: Limit, now: datetime) -> str:
    if limit.scope == "project" and limit.period == "monthly":
        return f"project:{now.astimezone().strftime('%Y-%m')}"
    if limit.scope == "project" and limit.period == "weekly":
        return f"project:{now.astimezone().strftime('%G-W%V')}"
    return limit.scope


def _money(spent: Spend) -> str:
    floor = "" if spent.complete else "at least "
    return f"{floor}${spent.usd:.2f}"


def _announce(found: Evaluation, state: dict[str, Any], now: datetime) -> None:
    announced = state.setdefault("announced", {})
    for limit in found.limits:
        level = limit.level(found.cfg)
        if level == "ok":
            continue
        key = _key(limit, now)
        seen = announced.get(key) if isinstance(announced.get(key), list) else []
        if level in seen:
            continue
        announced[key] = [*seen, level]
        what = "task" if limit.scope == "task" else f"project ({limit.period})"
        print(
            f"\n💰 Budget {level}: the {what} has spent {_money(limit.spent)} "
            f"of ${limit.limit:.2f} ({limit.percent:.0f} %)."
        )


def _completed_subtasks(spec_dir: Path) -> tuple[int, int]:
    """(completed, total) subtasks of the plan; (0, 0) without a plan."""
    try:
        plan = json.loads(
            (Path(spec_dir) / "implementation_plan.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return 0, 0
    subtasks = [
        s
        for phase in (plan.get("phases") or [] if isinstance(plan, dict) else [])
        if isinstance(phase, dict)
        for s in (phase.get("subtasks") or [])
        if isinstance(s, dict)
    ]
    done = sum(1 for s in subtasks if s.get("status") == "completed")
    return done, len(subtasks)


def _stalled(
    spec_dir: Path, cfg: budget_config.BudgetConfig, state: dict[str, Any]
) -> dict[str, Any] | None:
    """The stall verdict, or None; keeps the progress mark up to date."""
    if cfg.stall_multiplier <= 0:
        return None
    root = project_root(spec_dir)
    if root is None:
        return None
    spent = sum(r.cost for r in task_rows(root, Path(spec_dir).name))
    done, total = _completed_subtasks(spec_dir)
    mark = state.get("progress") if isinstance(state.get("progress"), dict) else {}
    if done != mark.get("completed") or "spentUsd" not in mark:
        state["progress"] = {"completed": done, "spentUsd": round(spent, 4)}
        return None
    if done == 0 or done >= total:
        return None
    since = spent - float(mark.get("spentUsd") or 0.0)
    average = float(mark.get("spentUsd") or 0.0) / done
    allowance = max(MIN_STALL_USD, cfg.stall_multiplier * average)
    if since < allowance:
        return None
    # A resume starts a fresh allowance from here.
    state["progress"] = {"completed": done, "spentUsd": round(spent, 4)}
    return {
        "scope": "stall",
        "spentUsd": round(since, 4),
        "limitUsd": round(allowance, 4),
        "completedSubtasks": done,
        "totalSubtasks": total,
    }


def spec_dirs(spec_dir: Path) -> list[Path]:
    """The task's spec directory and, for a worktree build, the main project's copy.

    The card reads the pause from the main copy and the build from its own:
    both get it, as the Pause button writes both.
    """
    found = [Path(spec_dir)]
    root = project_root(spec_dir)
    if root is not None:
        main = root / ".workpilot" / "specs" / Path(spec_dir).name
        if main.is_dir() and main.resolve() != Path(spec_dir).resolve():
            found.append(main)
    return found


def _pause(spec_dir: Path, phase: str, reason: str, detail: dict[str, Any]) -> None:
    for folder in spec_dirs(spec_dir):
        write_pause_state(folder, phase=phase, reason=reason, detail={"budget": detail})


def check_before_session(
    spec_dir: Path, phase: str, now: datetime | None = None
) -> str | None:
    """Announce thresholds; pause the task when its budget says so.

    Returns the reason (``budget`` or ``budget_stall``) when the build was
    paused, so the caller raises ``BuildPaused``; None otherwise. Never raises
    on a ledger or file it cannot read: a budget it cannot measure never stops
    work.
    """
    now = now or datetime.now(UTC)
    try:
        found = evaluate(spec_dir)
    except OSError as exc:
        logger.warning("budget not checked: %s", exc)
        return None
    if found is None:
        return None
    state = _load_state(spec_dir)
    _announce(found, state, now)
    over = found.exceeded()
    stall = _stalled(spec_dir, found.cfg, state)
    _save_state(spec_dir, state)
    if over is not None and found.cfg.on_exceed == "pause":
        detail = over.to_dict(found.cfg)
        _pause(spec_dir, phase, PAUSE_REASON, detail)
        what = "task" if over.scope == "task" else f"project ({over.period})"
        print("\n" + "=" * 70)
        print(f"  ⏸  BUDGET REACHED — the {what} has spent {_money(over.spent)}")
        print(f"     of its ${over.limit:.2f} limit. Paused before the next session.")
        print("=" * 70)
        print("Raise the limit on the card or in Costs, then resume the task.")
        return PAUSE_REASON
    if stall is not None:
        _pause(spec_dir, phase, STALL_REASON, stall)
        print("\n" + "=" * 70)
        print(
            f"  ⏸  NO PROGRESS — ${stall['spentUsd']:.2f} spent since the last "
            f"completed subtask ({stall['completedSubtasks']}/{stall['totalSubtasks']}),"
        )
        print(
            f"     over its ${stall['limitUsd']:.2f} allowance "
            f"({found.cfg.stall_multiplier:g} x the average of the earlier ones)."
        )
        print("=" * 70)
        print("Read the logs, then resume the task to give it a fresh allowance.")
        return STALL_REASON
    return None


__all__ = [
    "Evaluation",
    "Limit",
    "PAUSE_REASON",
    "STALL_REASON",
    "check_before_session",
    "degrade_steps",
    "evaluate",
]
