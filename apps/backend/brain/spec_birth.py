"""When the task behind a spec folder began.

A session note names its task by the spec folder (``003-test``), and that name
is not unique over time: delete a task and the next one takes its number, and
the same title gives the same slug. The new task then read the old one's
session notes as its own history — a planner for "Test" was handed the
recommendations of a November task that created ``toto.txt``.

A session cannot be older than the task it belongs to, so a note of the same
name written before this folder's task began is another task's. The start is
the earliest of what the folder records about itself: the ``created_at`` the
app writes into ``implementation_plan.json``, the first entry of
``status_history.json``, and the oldest file modification time in the folder.
Taking the earliest fails open: a wrong or missing date can only keep a note,
never hide one of this task's own.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

__all__ = ["born_at", "parse_moment", "predates"]

# Session timestamps and file times come from the same machine, but a note may
# be stamped from an insight a little before its write: a minute of slack.
_SLACK = timedelta(minutes=1)


def parse_moment(value: Any) -> datetime | None:
    """An ISO-8601 string → an aware datetime (naive means UTC), or ``None``."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        moment = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return None


def born_at(spec_dir: Path | str | None) -> datetime | None:
    """The earliest moment the folder's task is known to exist, or ``None``."""
    if spec_dir is None:
        return None
    spec_dir = Path(spec_dir)
    moments: list[datetime] = []

    plan = _read_json(spec_dir / "implementation_plan.json")
    if isinstance(plan, dict) and (moment := parse_moment(plan.get("created_at"))):
        moments.append(moment)

    history = _read_json(spec_dir / "status_history.json")
    entries = history.get("entries") if isinstance(history, dict) else None
    if isinstance(entries, list) and entries and isinstance(entries[0], dict):
        if moment := parse_moment(entries[0].get("at")):
            moments.append(moment)

    try:
        for child in spec_dir.iterdir():
            if child.is_file() and not child.is_symlink():
                moments.append(datetime.fromtimestamp(child.stat().st_mtime, tz=UTC))
    except OSError:
        pass

    return min(moments) if moments else None


def predates(timestamp: Any, born: datetime | None) -> bool:
    """Was a note stamped ``timestamp`` written before a task born ``born``?

    ``False`` whenever either date is unknown: an unreadable stamp is kept.
    """
    if born is None:
        return False
    moment = parse_moment(timestamp)
    return moment is not None and moment < born - _SLACK
