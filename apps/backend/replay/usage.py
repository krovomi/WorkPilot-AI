"""How this machine shares its replays, counted on this machine (#347).

The issue asked for usage metrics: sessions exported each week, the share of
replays people annotate, whether shared links are read. They are computed
here, from what the machine already holds, and never sent anywhere: there is
no telemetry. A server counts its own team links, for one project at a time
(``shared_features/replay_share_overview.py``).

- **Exports** are the only thing kept for this: one entry per file, page,
  video or team link the app actually produced (a dialog closed without
  saving is not one), with its time and its kind. No session id, no title,
  no path. The ledger lives beside the sessions (``usage/exports.json``) and
  keeps a year, at most ``MAX_EVENTS`` entries.
- **Sessions** are read from the store as they are: how many there are, how
  many carry a bookmark, a reply, a model's summary, how many were imported.
"""

from __future__ import annotations

import json
import logging
import math
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from foundation.json_ledger import update_json

logger = logging.getLogger(__name__)

#: What the app counts as one export, a closed list.
EXPORT_KINDS = ("wpreplay", "html", "video", "team_link")
WEEK = 7 * 24 * 3600
WEEKS = 8
KEEP_SECONDS = 365 * 24 * 3600
MAX_EVENTS = 5000
LEDGER = Path("usage") / "exports.json"


def ledger_path(storage_dir: Path) -> Path:
    return storage_dir / LEDGER


def _events(raw: Any) -> list[list[Any]]:
    """The ledger's entries that are one: ``[time, kind]``, a known kind."""
    entries = raw.get("exports") if isinstance(raw, dict) else None
    if not isinstance(entries, list):
        return []
    kept = []
    for entry in entries[-MAX_EVENTS:]:
        if (
            isinstance(entry, list)
            and len(entry) == 2
            and isinstance(entry[0], int | float)
            and not isinstance(entry[0], bool)
            and math.isfinite(entry[0])
            and entry[1] in EXPORT_KINDS
        ):
            kept.append([float(entry[0]), entry[1]])
    return kept


def record_export(storage_dir: Path, kind: str, now: float | None = None) -> None:
    """Count one export of ``kind``; an unknown kind is refused."""
    if kind not in EXPORT_KINDS:
        raise ValueError("unknown export kind")
    moment = time.time() if now is None else now

    def change(current: Any) -> dict[str, Any]:
        recent = [e for e in _events(current) if moment - e[0] < KEEP_SECONDS]
        recent.append([moment, kind])
        return {"version": 1, "exports": recent[-MAX_EVENTS:]}

    update_json(ledger_path(storage_dir), lambda: {}, change)


def _read_ledger(storage_dir: Path) -> list[list[Any]]:
    try:
        raw = json.loads(ledger_path(storage_dir).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    return _events(raw)


def _session_files(storage_dir: Path) -> Iterable[dict[str, Any]]:
    for path in storage_dir.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            logger.debug("Skipping unreadable replay %s: %s", path.name, error)
            continue
        if isinstance(data, dict):
            yield data


def _has_list(data: dict[str, Any], key: str) -> bool:
    value = data.get(key)
    return isinstance(value, list) and len(value) > 0


def _session_counts(storage_dir: Path) -> dict[str, int]:
    counts = {
        "total": 0,
        "annotated": 0,
        "discussed": 0,
        "summarized": 0,
        "imported": 0,
    }
    for data in _session_files(storage_dir):
        counts["total"] += 1
        marks = data.get("bookmarks")
        if _has_list(data, "bookmarks"):
            counts["annotated"] += 1
            if any(isinstance(m, dict) and _has_list(m, "replies") for m in marks):
                counts["discussed"] += 1
        if isinstance(data.get("summary"), dict):
            counts["summarized"] += 1
        tags = data.get("tags")
        if isinstance(tags, list) and "imported" in tags:
            counts["imported"] += 1
    return counts


def _ratio(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


def usage_report(storage_dir: Path, now: float | None = None) -> dict[str, Any]:
    """This machine's replay usage: exports over the last ``WEEKS`` weeks
    (rolling windows of seven days, the latest last) and its sessions."""
    moment = time.time() if now is None else now
    start = moment - WEEKS * WEEK
    weeks = [
        {
            "start": start + i * WEEK,
            "end": start + (i + 1) * WEEK,
            "total": 0,
            "by_kind": dict.fromkeys(EXPORT_KINDS, 0),
        }
        for i in range(WEEKS)
    ]
    for at, kind in _read_ledger(storage_dir):
        if not start <= at < moment:
            continue
        week = weeks[min(int((at - start) // WEEK), WEEKS - 1)]
        week["total"] += 1
        week["by_kind"][kind] += 1
    exports = sum(w["total"] for w in weeks)
    sessions = _session_counts(storage_dir)
    return {
        "weeks": weeks,
        "exports": exports,
        "exports_per_week": round(exports / WEEKS, 2),
        "sessions": sessions,
        "annotated_ratio": _ratio(sessions["annotated"], sessions["total"]),
    }
