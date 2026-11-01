"""What the agents of a server project spent, read from the ledgers they keep in its clone.

Every agent session records its tokens and cost (``core.usage_tracker``) in
``.workpilot/cost_data.json`` of the directory it works in, and its QA verdicts
and merges in ``.workpilot/dashboard_snapshot.json`` beside it: the clone
itself for the spec phase and the project's jobs, a card's build workspace
(``.workpilot/worktrees/tasks/<card>/``) for its build and its QA. The
server's database records who ran what and when, not what it cost, so the
workspace views (``shared_features.workspace``) read these files, and only
these: the two names below, in the clone's ``.workpilot`` and in each build
workspace named like a card, each a regular file under its size, resolved
inside the clone, with a ceiling on the whole read.

A ledger is written by a run, that is by an agent that reads untrusted
content: what is taken from it is numbers, a timestamp, and a provider, model,
phase and card name cut to a label. Its ``project_id`` field, the directory
the run worked in on the server, is never read.
"""

from __future__ import annotations

import json
import math
import os
import stat
from collections import defaultdict
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

LEDGER = "cost_data.json"
SNAPSHOT = "dashboard_snapshot.json"
#: The files read, with the most of each that is read.
FILE_LIMITS: dict[str, int] = {LEDGER: 8_000_000, SNAPSHOT: 200_000}
#: Build workspaces read, at most; and everything read, at most, in bytes.
MAX_WORKSPACES = 500
MAX_TOTAL_BYTES = 64_000_000
MAX_USAGES = 200_000
LABEL_MAX = 120
WINDOW_DAYS = 30


@dataclass(frozen=True, slots=True)
class Usage:
    """One agent session's spend."""

    spec_id: str
    provider: str
    model: str
    phase: str
    input_tokens: int
    output_tokens: int
    cost: float
    at: datetime

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass(slots=True)
class Ledgers:
    """Everything the project's ledgers say, all workspaces together."""

    usages: list[Usage] = field(default_factory=list)
    qa_total: int = 0
    qa_passed: int = 0
    qa_score_sum: float = 0.0
    merge_auto: int = 0
    merge_manual: int = 0


def _label(value: object) -> str:
    return value.strip()[:LABEL_MAX] if isinstance(value, str) else ""


def _count(value: object) -> int:
    # A bool is an int to Python; a ledger never means it as a count.
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    try:
        number = float(value)
    except OverflowError:
        # An integer too large for a float is no count a run wrote.
        return 0
    return int(number) if math.isfinite(number) and number >= 0 else 0


def _amount(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    try:
        number = float(value)
    except OverflowError:
        return 0.0
    return number if math.isfinite(number) and number >= 0 else 0.0


def _moment(value: object) -> datetime | None:
    if not isinstance(value, str) or len(value) > 64:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _usage(raw: object) -> Usage | None:
    if not isinstance(raw, dict):
        return None
    at = _moment(raw.get("timestamp"))
    if at is None:
        return None
    return Usage(
        spec_id=_label(raw.get("spec_id")),
        provider=_label(raw.get("provider")) or "unknown",
        model=_label(raw.get("model")) or "unknown",
        phase=_label(raw.get("phase")),
        input_tokens=_count(raw.get("input_tokens")),
        output_tokens=_count(raw.get("output_tokens")),
        cost=_amount(raw.get("cost")),
        at=at,
    )


def _workspaces(clone: Path) -> Iterator[Path]:
    """The clone's ``.workpilot``, then each build workspace's, by card name."""
    from board_mcp.server import CARD_ID

    yield clone / ".workpilot"
    tasks = clone / ".workpilot" / "worktrees" / "tasks"
    try:
        # A build workspace can be removed while it is listed.
        names = sorted(
            (entry.name for entry in tasks.iterdir() if CARD_ID.match(entry.name)),
            reverse=True,
        )
    except OSError:
        return
    for name in names[:MAX_WORKSPACES]:
        yield tasks / name / ".workpilot"


def _read(path: Path, root: Path, limit: int) -> tuple[Any, int]:
    """A JSON file's value and the bytes read for it; nothing for a link, a
    file out of the clone, over its size, or not JSON.

    The file is opened without following a link and checked on the open file
    itself, so one swapped in after the path was checked is not read either.
    """
    try:
        if not path.resolve().is_relative_to(root):
            return None, 0
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError:
        return None, 0
    with os.fdopen(fd, "rb") as handle:
        try:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                return None, 0
            data = handle.read(limit + 1)
        except OSError:
            return None, 0
    if len(data) > limit:
        return None, len(data)
    try:
        # What was read counts against the whole read, JSON or not.
        return json.loads(data.decode("utf-8")), len(data)
    except (UnicodeDecodeError, ValueError):
        return None, len(data)


def read_ledgers(clone: Path) -> Ledgers:
    """Read the ledgers of a project's clone (see the module's docstring)."""
    root = clone.resolve()
    found = Ledgers()
    budget = MAX_TOTAL_BYTES
    for directory in _workspaces(clone):
        for name, limit in FILE_LIMITS.items():
            if budget <= 0:
                return found
            value, size = _read(directory / name, root, min(limit, budget))
            budget -= size
            if not isinstance(value, dict):
                continue
            if name == LEDGER:
                usages = value.get("usages")
                for raw in usages if isinstance(usages, list) else ():
                    if len(found.usages) >= MAX_USAGES:
                        break
                    usage = _usage(raw)
                    if usage is not None:
                        found.usages.append(usage)
            else:
                found.qa_total += _count(value.get("_qa_total"))
                found.qa_passed += _count(value.get("_qa_passed"))
                found.qa_score_sum += _amount(value.get("_qa_score_sum"))
                found.merge_auto += _count(value.get("merge_auto_count"))
                found.merge_manual += _count(value.get("merge_manual_count"))
    return found


def cost_summary(usages: list[Usage], now: datetime) -> dict[str, Any]:
    """The last thirty days of spend, as the desktop's Costs view reads it
    (``cost-handlers.ts``, ``costs:getSummary``), against the thirty before."""
    since = now - timedelta(days=WINDOW_DAYS)
    before = now - timedelta(days=2 * WINDOW_DAYS)
    recent = [u for u in usages if since <= u.at <= now]
    previous_cost = sum(u.cost for u in usages if before <= u.at < since)
    total = sum(u.cost for u in recent)
    by_provider: dict[str, float] = defaultdict(float)
    by_model: dict[str, float] = defaultdict(float)
    for usage in recent:
        by_provider[usage.provider] += usage.cost
        by_model[f"{usage.provider}/{usage.model}"] += usage.cost
    days = WINDOW_DAYS
    if recent:
        span = max(u.at for u in recent) - min(u.at for u in recent)
        days = max(1, min(WINDOW_DAYS, math.ceil(span / timedelta(days=1)) + 1))
    tokens_in = sum(u.input_tokens for u in recent)
    tokens_out = sum(u.output_tokens for u in recent)
    return {
        "total_cost": total,
        "cost_by_provider": dict(by_provider),
        "cost_by_model": dict(by_model),
        "total_tokens": tokens_in + tokens_out,
        "tokens_input": tokens_in,
        "tokens_output": tokens_out,
        "period_days": days,
        "daily_avg": total / days,
        "trend_pct": (total - previous_cost) / previous_cost * 100
        if previous_cost > 0
        else 0.0,
    }


def dashboard(ledgers: Ledgers, tasks_by_status: dict[str, int]) -> dict[str, Any]:
    """The desktop's dashboard snapshot (``dashboard_snapshot.json``), for every
    workspace of the project together; the cards counted by the server."""
    tokens_by_provider: dict[str, int] = defaultdict(int)
    cost_by_model: dict[str, float] = defaultdict(float)
    for usage in ledgers.usages:
        tokens_by_provider[usage.provider] += usage.tokens
        cost_by_model[f"{usage.provider}/{usage.model}"] += usage.cost
    qa_total = ledgers.qa_total
    return {
        "tasks_by_status": tasks_by_status,
        # Nothing records how long a card took by complexity, on the desktop
        # either: the view shows it empty.
        "avg_completion_by_complexity": {},
        "qa_first_pass_rate": ledgers.qa_passed / qa_total * 100 if qa_total else 0.0,
        "qa_avg_score": ledgers.qa_score_sum / qa_total if qa_total else 0.0,
        "total_tokens": sum(u.tokens for u in ledgers.usages),
        "tokens_by_provider": dict(tokens_by_provider),
        "total_cost": sum(u.cost for u in ledgers.usages),
        "cost_by_model": dict(cost_by_model),
        "merge_auto_count": ledgers.merge_auto,
        "merge_manual_count": ledgers.merge_manual,
    }


def by_card(usages: Iterable[Usage]) -> dict[str, list[Usage]]:
    """Each card's usages, the oldest first."""
    grouped: dict[str, list[Usage]] = defaultdict(list)
    for usage in usages:
        if usage.spec_id:
            grouped[usage.spec_id].append(usage)
    for spent in grouped.values():
        spent.sort(key=lambda u: u.at)
    return dict(grouped)


def spent_during(
    usages: list[Usage], start: datetime, end: datetime
) -> dict[str, Any] | None:
    """A run's spend: its card's usages between its start and its end, with
    the part of each phase; None when none falls in."""
    inside = [u for u in usages if start <= u.at <= end]
    if not inside:
        return None
    phases: dict[str, list[float]] = {}
    for usage in inside:
        tokens, cost = phases.setdefault(usage.phase or "agent", [0, 0.0])
        phases[usage.phase or "agent"] = [tokens + usage.tokens, cost + usage.cost]
    return {
        "tokens": sum(u.tokens for u in inside),
        "cost": sum(u.cost for u in inside),
        "phases": [
            {"name": name, "tokens": int(tokens), "cost": cost}
            for name, (tokens, cost) in phases.items()
        ],
    }
