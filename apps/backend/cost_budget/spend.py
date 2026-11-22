"""What a project and one of its tasks have spent, read from the usage ledger.

``core.usage_tracker`` appends every agent session to
``<project>/.workpilot/cost_data.json``, whatever the provider: the cost the
provider reported, or the catalog's price of its tokens. A session whose model
has no known price records 0 beside real tokens: the total is then a floor,
and says so (``complete=False``).

A spec directory in a task worktree (``<root>/.workpilot/worktrees/tasks/<t>/
.workpilot/specs/<t>``) belongs to the project above the first ``.workpilot``.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

LEDGER = "cost_data.json"
MAX_BYTES = 50 * 1024 * 1024


@dataclass(frozen=True)
class Spend:
    usd: float
    complete: bool


@dataclass(frozen=True)
class Usage:
    spec_id: str
    cost: float
    tokens: int
    at: datetime | None


def project_root(spec_dir: Path) -> Path | None:
    """The project that owns ``spec_dir`` (a task worktree's main project, too)."""
    parts = Path(spec_dir).resolve().parts
    for index, part in enumerate(parts):
        if part == ".workpilot" and index:
            return Path(*parts[:index])
    return None


def _when(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return 0.0
    return float(value) if value > 0 else 0.0


_cache: dict[str, tuple[tuple[int, int], list[Usage]]] = {}
# A rewrite of the same size inside one tick of a coarse clock (Windows,
# FAT: up to 2 s) keeps the modification time. A ledger read that soon after
# its last write is not kept, like git's "racy" index entries.
RACY_NS = 2_000_000_000


def usages(root: Path) -> list[Usage]:
    """The ledger's sessions; none when it is missing, a link or unreadable."""
    folder = root / ".workpilot"
    path = folder / LEDGER
    if folder.is_symlink() or path.is_symlink() or not path.is_file():
        return []
    try:
        info = path.stat()
    except OSError:
        return []
    stamp = (info.st_mtime_ns, info.st_size)
    cached = _cache.get(str(path))
    if cached and cached[0] == stamp:
        return cached[1]
    if info.st_size > MAX_BYTES:
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows = data.get("usages") if isinstance(data, dict) else None
    found: list[Usage] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        tokens = int(
            _number(row.get("input_tokens")) + _number(row.get("output_tokens"))
        )
        found.append(
            Usage(
                spec_id=str(row.get("spec_id") or ""),
                cost=_number(row.get("cost")),
                tokens=tokens,
                at=_when(row.get("timestamp")),
            )
        )
    if time.time_ns() - info.st_mtime_ns > RACY_NS:
        _cache[str(path)] = (stamp, found)
    else:
        _cache.pop(str(path), None)
    return found


def _total(rows: list[Usage]) -> Spend:
    usd = sum(r.cost for r in rows)
    complete = all(r.cost > 0 or not r.tokens for r in rows)
    return Spend(round(usd, 4), complete)


def period_start(period: str, now: datetime | None = None) -> datetime | None:
    """Where the period began, in local time like the Costs page; None for ``total``."""
    local = (now or datetime.now(UTC)).astimezone()
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    if period == "monthly":
        return midnight.replace(day=1)
    if period == "weekly":
        # The page's week starts on Sunday (JavaScript's getDay() == 0).
        return midnight - timedelta(days=(midnight.weekday() + 1) % 7)
    return None


def project_spend(root: Path, period: str, now: datetime | None = None) -> Spend:
    start = period_start(period, now)
    rows = usages(root)
    if start is not None:
        rows = [r for r in rows if r.at is not None and r.at >= start]
    return _total(rows)


def task_rows(root: Path, spec_id: str) -> list[Usage]:
    return [r for r in usages(root) if r.spec_id == spec_id]


def task_spend(root: Path, spec_id: str) -> Spend:
    return _total(task_rows(root, spec_id))


__all__ = [
    "Spend",
    "Usage",
    "period_start",
    "project_root",
    "project_spend",
    "task_rows",
    "task_spend",
    "usages",
]
