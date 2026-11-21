"""How the memory's lifecycle behaves, read from its journal.

The issue's three signals, plus what a team needs to tell a lifecycle that
helps from one that gets in the way:

| Figure | Read from | Says |
|---|---|---|
| ``restores_week`` | ``restore`` entries of the last 7 days | many → automations remove too much |
| ``undone_week`` | entries that take another back (``undoes``) | the same, said louder |
| ``automatic_forgets_week`` | ``forget`` by an agent or the learning loop | what the automations removed |
| ``pinned`` / ``live`` / ``pin_rate`` | the live notes | how much the team protects |
| ``conflicts_month``, ``auto_settled_month``, ``resolved_month`` | ``conflict``, ``archive`` by ``sync``, ``resolve`` | conflicts found per sync, and who settled them |
| ``mean_resolution_hours`` | a ``conflict`` and the ``resolve`` of the same notes | how long a pair waits for a person |
| ``history_views`` | this machine's count of "why?" opened | whether the explanations are read |

Nothing here is sent anywhere. The view count is this machine's
(``.workpilot-brain/lifecycle-views.json``, ignored by git): counting it in
the vault would make every reading a commit.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .journal import JournalEntry
from .store import iter_live

logger = logging.getLogger(__name__)

__all__ = ["AGGRESSIVE_RESTORES", "VIEWS_FILE", "compute", "count_view", "views"]

VIEWS_FILE = ".workpilot-brain/lifecycle-views.json"
AGGRESSIVE_RESTORES = 5
"""Restores in a week (an undo is one) from which the tab says the automations remove too much."""


def _when(value: str) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _load_views(root: Path) -> dict[str, int]:
    try:
        data = json.loads((root / VIEWS_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): v for k, v in data.items() if isinstance(v, int)}


def views(root: Path, base: Path | str) -> int:
    return _load_views(root).get(Path(base).as_posix(), 0)


def count_view(root: Path, base: Path | str) -> None:
    """One more "why?" opened on this machine for the memory at *base*."""
    data = _load_views(root)
    key = Path(base).as_posix()
    data[key] = data.get(key, 0) + 1
    target = root / VIEWS_FILE
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except OSError as exc:
        logger.debug("brain: lifecycle view count not saved: %s", exc)


def _resolution_hours(entries: list[tuple[datetime, JournalEntry]]) -> float | None:
    """Mean time from a conflict to the resolve that names the same notes."""
    found = sorted(
        ((m, e) for m, e in entries if e.action == "conflict"), key=lambda i: i[0]
    )
    waits = []
    for moment, entry in entries:
        if entry.action != "resolve":
            continue
        names = {entry.note, *entry.related}
        earlier = [m for m, c in found if m <= moment and names & {c.note, *c.related}]
        if earlier:
            waits.append((moment - earlier[-1]).total_seconds() / 3600)
    return round(sum(waits) / len(waits), 1) if waits else None


def compute(
    root: Path,
    base: Path | str,
    entries: list[JournalEntry],
    *,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The figures of the table above, for the memory at *base*."""
    moment = now or datetime.now(UTC)
    week, month = moment - timedelta(days=7), moment - timedelta(days=30)
    dated = [(m, e) for e in entries if (m := _when(e.ts)) is not None]
    this_week = [e for m, e in dated if m >= week]
    this_month = [(m, e) for m, e in dated if m >= month]
    live = list(iter_live(root, base))
    pinned = sum(1 for _, note in live if note.meta.get("pinned") is True)
    restores = sum(1 for e in this_week if e.action == "restore")
    undone = sum(1 for e in this_week if e.undoes)
    return {
        "restores_week": restores,
        "undone_week": undone,
        "automatic_forgets_week": sum(
            1 for e in this_week if e.action == "forget" and e.actor != "user"
        ),
        "live": len(live),
        "pinned": pinned,
        "pin_rate": round(pinned / len(live), 3) if live else 0.0,
        "conflicts_month": sum(1 for _, e in this_month if e.action == "conflict"),
        "auto_settled_month": sum(
            1 for _, e in this_month if e.action == "archive" and e.actor == "sync"
        ),
        "resolved_month": sum(1 for _, e in this_month if e.action == "resolve"),
        "mean_resolution_hours": _resolution_hours(this_month),
        "history_views": views(root, base),
        "too_aggressive": restores >= AGGRESSIVE_RESTORES,
    }
