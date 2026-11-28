"""What Mission Control sessions did, kept to measure auto-compose and calibrate it.

A session that ran at least one agent leaves one entry when it ends
(``orchestrator.stop_session``, or a new session started over it): where its
crew came from (``auto``, ``manual`` or ``mixed``), the tokens the
composition expected and those the agents spent, its budget and whether it was
exceeded, and how many times an agent was rebalanced.

The entries answer the issue's four questions (``summary``): the share of
sessions started through auto-compose, the average tokens of an auto session
against a manual one, the rebalancings per session, and how often a budget was
exceeded. They also calibrate the composition (``role_factors``): once a role
has ``MIN_SAMPLES`` runs of an auto-composed agent, its token estimate is
multiplied by the median of what it really spent over what was expected.

The ledger is the person's, not a project's: ``<data dir>/mission-control/
metrics.json``, the data dir being ``WORKPILOT_DATA_DIR`` or ``~/.workpilot``.
It holds numbers and role names, never a task, an answer or an error.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from statistics import median
from typing import Any

from foundation.json_ledger import update_json

MAX_ENTRIES = 500
MIN_SAMPLES = 3
# How far a role's estimate may move: beyond it, one odd run is not history.
FACTOR_BOUNDS = (0.25, 4.0)
ORIGINS = frozenset({"auto", "manual", "mixed"})


def ledger_path() -> Path:
    base = os.environ.get("WORKPILOT_DATA_DIR") or str(Path.home() / ".workpilot")
    return Path(base) / "mission-control" / "metrics.json"


def _empty() -> dict[str, Any]:
    return {"version": 1, "sessions": []}


def _entries(data: object) -> list[dict[str, Any]]:
    if not isinstance(data, dict):
        return []
    sessions = data.get("sessions")
    if not isinstance(sessions, list):
        return []
    return [e for e in sessions if isinstance(e, dict) and e.get("origin") in ORIGINS]


def load() -> list[dict[str, Any]]:
    """Every recorded session; none when the ledger is missing or unreadable."""
    path = ledger_path()
    if path.is_symlink():
        return []
    try:
        return _entries(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return []


def record_session(entry: dict[str, Any]) -> None:
    """Append one session's entry, keeping the last ``MAX_ENTRIES``."""
    path = ledger_path()
    if path.is_symlink():
        return

    def change(data: object) -> dict[str, Any]:
        sessions = _entries(data)
        sessions.append({**entry, "at": time.time()})
        return {"version": 1, "sessions": sessions[-MAX_ENTRIES:]}

    try:
        update_json(path, _empty, change)
    except OSError:
        # Metrics never stop a session from ending.
        return


def _mean(values: list[float]) -> float | None:
    return round(sum(values) / len(values), 2) if values else None


def summary(entries: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """The issue's four measures over every recorded session."""
    sessions = load() if entries is None else entries
    total = len(sessions)
    auto = [s for s in sessions if s["origin"] in ("auto", "mixed")]
    manual = [s for s in sessions if s["origin"] == "manual"]
    budgeted = [s for s in sessions if s.get("budget_usd") or s.get("budget_tokens")]
    avg_auto = _mean([float(s.get("actual_tokens", 0)) for s in auto])
    avg_manual = _mean([float(s.get("actual_tokens", 0)) for s in manual])
    ratios = [
        s["actual_tokens"] / s["estimated_tokens"]
        for s in auto
        if s.get("estimated_tokens") and s.get("actual_tokens")
    ]
    return {
        "sessions": total,
        "auto_share": round(len(auto) / total, 2) if total else None,
        "avg_tokens_auto": avg_auto,
        "avg_tokens_manual": avg_manual,
        "delta_tokens": (
            round(avg_auto - avg_manual, 2)
            if avg_auto is not None and avg_manual is not None
            else None
        ),
        "estimate_ratio": round(median(ratios), 2) if ratios else None,
        "rebalances_per_session": _mean(
            [float(s.get("rebalances", 0)) for s in sessions]
        ),
        "budget_sessions": len(budgeted),
        "overrun_rate": (
            round(sum(1 for s in budgeted if s.get("over_budget")) / len(budgeted), 2)
            if budgeted
            else None
        ),
    }


def role_factors(entries: list[dict[str, Any]] | None = None) -> dict[str, float]:
    """Per role, the median of spent over expected tokens, once it has history."""
    sessions = load() if entries is None else entries
    ratios: dict[str, list[float]] = {}
    for session in sessions:
        roles = session.get("roles")
        if not isinstance(roles, list):
            continue
        for row in roles:
            if not isinstance(row, dict):
                continue
            role, estimated, actual = (
                row.get("role"),
                row.get("estimated"),
                row.get("actual"),
            )
            if (
                isinstance(role, str)
                and isinstance(estimated, int | float)
                and isinstance(actual, int | float)
                and estimated > 0
                and actual > 0
            ):
                ratios.setdefault(role, []).append(actual / estimated)
    low, high = FACTOR_BOUNDS
    return {
        role: round(min(high, max(low, median(values))), 2)
        for role, values in ratios.items()
        if len(values) >= MIN_SAMPLES
    }


__all__ = [
    "MIN_SAMPLES",
    "ledger_path",
    "load",
    "record_session",
    "role_factors",
    "summary",
]
