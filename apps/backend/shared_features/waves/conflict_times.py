"""When a card's merge conflict appeared on the server and when it was
resolved (#358, lot 4): ``.workpilot/merge-conflict-times.json`` in the
clone, the desktop's file name and shape, newest first, at most 200.

A ``merge`` run of a card that fails while git finds a conflict between the
card's workspace and its base branch opens an entry for the card (one open
entry per card); the card's next ``merge`` run that succeeds closes it. Two
dates the server saw, never an estimate. The file goes through the run
store's folder checks, bounded read and atomic write; entries are rebuilt
field by field when read.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from statistics import median
from typing import Any

from . import git_reads
from .run_store import (
    SPRINT_DAYS,
    StoreRefused,
    _card_id,
    _moment,
    _read,
    write_atomically,
)

logger = logging.getLogger(__name__)

TIMES_FILE = "merge-conflict-times.json"
VERSION = 1
MAX_ENTRIES = 200
MAX_TIMES_BYTES = 64 * 1024
#: A trial merge after a failed merge run: one call, bounded.
CHECK_TIMEOUT_S = 8


def validate_entry(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict) or not _card_id(raw.get("taskId")):
        return None
    detected = _moment(raw.get("detectedAt"))
    if detected is None or "resolvedAt" not in raw:
        return None
    if raw["resolvedAt"] is None:
        return {"taskId": raw["taskId"], "detectedAt": detected, "resolvedAt": None}
    resolved = _moment(raw["resolvedAt"])
    if resolved is None or datetime.fromisoformat(resolved) < datetime.fromisoformat(
        detected
    ):
        return None
    return {"taskId": raw["taskId"], "detectedAt": detected, "resolvedAt": resolved}


def load_times(clone: Path) -> dict[str, Any]:
    raw, ignored = _read(clone, TIMES_FILE, MAX_TIMES_BYTES)
    if raw is None:
        return {"entries": [], "ignored": ignored}
    if (
        not isinstance(raw, dict)
        or raw.get("version") != VERSION
        or not isinstance(raw.get("entries"), list)
    ):
        return {"entries": [], "ignored": True}
    entries = [validate_entry(e) for e in raw["entries"][:MAX_ENTRIES]]
    if any(e is None for e in entries):
        return {"entries": [], "ignored": True}
    return {"entries": entries, "ignored": False}


def _write(clone: Path, entries: list[dict[str, Any]]) -> None:
    write_atomically(
        clone,
        TIMES_FILE,
        json.dumps({"version": VERSION, "entries": entries[:MAX_ENTRIES]}),
    )


def _is_open(entry: dict[str, Any], card: str) -> bool:
    return entry["taskId"] == card and entry["resolvedAt"] is None


def note_conflict(clone: Path, card: str, now: datetime) -> None:
    entries = load_times(clone)["entries"]
    if any(_is_open(e, card) for e in entries):
        return
    opened = {"taskId": card, "detectedAt": now.isoformat(), "resolvedAt": None}
    _write(clone, [opened, *entries])


def note_merged(clone: Path, card: str, now: datetime) -> None:
    entries = load_times(clone)["entries"]
    index = next((i for i, e in enumerate(entries) if _is_open(e, card)), None)
    if index is None:
        return
    detected = datetime.fromisoformat(entries[index]["detectedAt"])
    entries[index] = {**entries[index], "resolvedAt": max(now, detected).isoformat()}
    _write(clone, entries)


def merge_conflicts(clone: Path, card: str, base: str) -> bool:
    """Whether git finds a conflict between the card's workspace and its base."""
    if not git_reads.BRANCH.match(base) or ".." in base:
        return False
    theirs = git_reads.workspace_head(clone, card)
    if theirs is None:
        return False
    for ref in (f"refs/heads/{base}", f"refs/remotes/origin/{base}"):
        ours = git_reads.git(
            clone,
            ["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"],
            timeout=git_reads.HEAD_TIMEOUT_S,
        )
        if ours is not None:
            outcome = git_reads.trial_merge(
                clone, ours.strip(), theirs, CHECK_TIMEOUT_S
            )
            return outcome is not None and outcome.verdict == "conflict"
    return False


def record_merge_run(
    clone: Path, card: str, succeeded: bool, base: str, now: datetime | None = None
) -> None:
    """A card's ``merge`` run ended: never fails the caller."""
    moment = now or datetime.now(UTC)
    try:
        if succeeded:
            note_merged(clone, card, moment)
        elif merge_conflicts(clone, card, base):
            note_conflict(clone, card, moment)
    except (OSError, StoreRefused) as error:
        logger.warning("Merge conflict time not recorded: %s", type(error).__name__)


def resolution_summary(times: dict[str, Any], now: datetime) -> dict[str, Any]:
    """The last 14 days: conflicts resolved and their median time from the
    conflict to the merge, in seconds (measured), plus those still open."""
    since = now - timedelta(days=SPRINT_DAYS)
    durations = [
        (
            datetime.fromisoformat(e["resolvedAt"])
            - datetime.fromisoformat(e["detectedAt"])
        ).total_seconds()
        for e in times["entries"]
        if e["resolvedAt"] is not None
        and datetime.fromisoformat(e["resolvedAt"]) >= since
    ]
    return {
        "ignored": times["ignored"],
        "resolved": len(durations),
        "medianSeconds": median(durations) if durations else None,
        "open": sum(1 for e in times["entries"] if e["resolvedAt"] is None),
    }
