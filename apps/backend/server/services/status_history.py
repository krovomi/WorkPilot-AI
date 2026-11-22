"""Every status a server card went through: ``<spec>/status_history.json``.

The same file, in the same format, as the desktop app writes for a local task
(``apps/frontend/src/main/task-status-history.ts``): ``{"version": 1,
"entries": [{from, to, reason?, at, actor, accountId?}]}``, oldest first. The
board's reports (cycle time, flow diagram, burndown) read it, and the board's
snapshot sends it to the app (``shared_board/api.py``, ``SNAPSHOT_FILES``).

On a server, a card's status changes in two places:

- a run's agents write it in the plan while they work; :func:`follow_status`,
  started by the run manager for the run's length, sees each change and
  records it with ``actor="agent"`` and the account that started the run;
- a person's action on the board (creating a card, sending its work back)
  records it with ``actor="user"`` and that person's account
  (:func:`record_status_change`).

Only the card's folder in the clone holds the history, never the build
workspace's copy: one history per card, kept when the workspace goes.

Personal data: an account id, nothing else (no name, no e-mail, no text), the
same id the board already shows as a card's author or claimer; the history
goes with the card. The file is bounded (:data:`MAX_ENTRIES`, the creation
kept). Recording never fails a run or a request: a history that cannot be
written is a gap in a report.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

HISTORY_FILE = "status_history.json"
#: The most entries kept: the first (the creation) and the latest others.
MAX_ENTRIES = 300
#: How often a run's card is looked at while the run works.
POLL_S = 2.0

#: The statuses the board knows (``TaskStatus`` in the app).
STATUSES = frozenset(
    {
        "backlog",
        "queue",
        "in_progress",
        "ai_review",
        "human_review",
        "build_failed",
        "done",
        "pr_created",
        "error",
    }
)
#: Why a card is in review (``ReviewReason`` in the app).
REASONS = frozenset(
    {
        "completed",
        "errors",
        "qa_rejected",
        "qa_unverified",
        "plan_review",
        "stopped",
        "prompt_too_long",
    }
)
ACTORS = frozenset({"agent", "user", "system"})
#: A plan's own words for a status, as the app reads them (``project-store``).
_PLAN_STATUS = {"pending": "backlog", "queued": "queue", "completed": "done"}
_ACCOUNT_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

_SPECS = Path(".workpilot") / "specs"
_WORKSPACES = Path(".workpilot") / "worktrees" / "tasks"

_lock = threading.Lock()


def _entry(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    to = raw.get("to")
    source = raw.get("from")
    actor = raw.get("actor")
    at = raw.get("at")
    if to not in STATUSES or (source is not None and source not in STATUSES):
        return None
    if actor not in ACTORS or not isinstance(at, str):
        return None
    try:
        datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return None
    entry: dict[str, Any] = {"from": source, "to": to, "at": at, "actor": actor}
    if raw.get("reason") in REASONS:
        entry["reason"] = raw["reason"]
    account = raw.get("accountId")
    if isinstance(account, str) and _ACCOUNT_ID.match(account):
        entry["accountId"] = account
    return entry


def _bound(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(entries) <= MAX_ENTRIES:
        return entries
    return [entries[0], *entries[len(entries) - (MAX_ENTRIES - 1) :]]


def read_status_history(spec_dir: Path) -> list[dict[str, Any]]:
    """The card's history, oldest first, each entry checked; empty if none."""
    try:
        raw = json.loads((spec_dir / HISTORY_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    items = raw.get("entries") if isinstance(raw, dict) else None
    if not isinstance(items, list):
        return []
    return _bound([e for e in (_entry(item) for item in items) if e is not None])


def plan_status(spec_dir: Path) -> tuple[str | None, str | None]:
    """The status and review reason a card's plan holds, as the board reads them."""
    try:
        plan = json.loads(
            (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None, None
    if not isinstance(plan, dict):
        return None, None
    status = plan.get("status")
    status = _PLAN_STATUS.get(status, status) if isinstance(status, str) else None
    reason = plan.get("reviewReason")
    return (
        status if status in STATUSES else None,
        reason if reason in REASONS else None,
    )


def record_status_change(
    spec_dir: Path,
    to: str,
    *,
    actor: str,
    reason: str | None = None,
    account_id: str | None = None,
    previous: tuple[str | None, str | None] | None = None,
    at: datetime | None = None,
) -> bool:
    """Append a change to the card's history, unless it changes nothing.

    The status it leaves is the last one recorded; while the history is
    empty, ``previous`` (what the plan said before). The same status with the
    same reason is no change. Returns whether an entry was written.
    """
    if to not in STATUSES or actor not in ACTORS:
        return False
    reason = reason if reason in REASONS else None
    try:
        with _lock:
            entries = read_status_history(spec_dir)
            if entries:
                source, source_reason = entries[-1]["to"], entries[-1].get("reason")
            else:
                source, source_reason = previous or (None, None)
            if source == to and source_reason == reason:
                return False
            entry: dict[str, Any] = {
                "from": source,
                "to": to,
                "at": (at or datetime.now(UTC)).isoformat().replace("+00:00", "Z"),
                "actor": actor,
            }
            if reason:
                entry["reason"] = reason
            if account_id and _ACCOUNT_ID.match(account_id):
                entry["accountId"] = account_id
            target = spec_dir / HISTORY_FILE
            # Replaced, never written in place: a reader never sees half a
            # file, and a link planted where it goes is replaced, not followed.
            temporary = spec_dir / f"{HISTORY_FILE}.{os.getpid()}.tmp"
            temporary.write_text(
                json.dumps(
                    {"version": 1, "entries": _bound([*entries, entry])}, indent=2
                ),
                encoding="utf-8",
            )
            os.replace(temporary, target)
            return True
    except OSError as e:
        logger.warning("Status history of %s not written: %s", spec_dir.name, e)
        return False


def card_dirs(root: Path, card: str) -> tuple[Path, Path]:
    """The card's folder in the clone and its build workspace's copy."""
    return root / _SPECS / card, root / _WORKSPACES / card / _SPECS / card


def observe(root: Path, card: str, account_id: str | None) -> bool:
    """Record the status the board shows for a card now, as its agents' doing.

    While a build runs, its workspace holds the live plan (as the board reads
    it, ``shared_board/listing.card_source``); the history stays in the clone.
    A copy that resolves outside the clone is not read.
    """
    main, workspace = card_dirs(root, card)
    try:
        resolved_root = root.resolve()
        if not main.is_dir() or not main.resolve().is_relative_to(resolved_root):
            return False
        source = main
        if workspace.is_dir() and workspace.resolve().is_relative_to(resolved_root):
            source = workspace
    except (OSError, RuntimeError):  # a link loop on the way
        return False
    status, reason = plan_status(source)
    if status is None:
        return False
    return record_status_change(
        main, status, actor="agent", reason=reason, account_id=account_id
    )


async def follow_status(
    root: Path, card: str, account_id: str | None, every: float | None = None
) -> None:
    """Record the card's status changes until cancelled, then once more.

    Started by the run manager beside a run and cancelled when it ends: the
    last look catches the status the run left the card in.
    """
    try:
        while True:
            await asyncio.to_thread(observe, root, card, account_id)
            await asyncio.sleep(POLL_S if every is None else every)
    except asyncio.CancelledError:
        observe(root, card, account_id)
        raise


async def stop_following(follower: asyncio.Task[None] | None) -> None:
    """Stop a :func:`follow_status` task and let its last look finish."""
    if follower is None or follower.done():
        return
    follower.cancel()
    try:
        await follower
    except asyncio.CancelledError:
        # Our own cancel of the follower; a cancel of this caller comes again
        # at its next await.
        pass
