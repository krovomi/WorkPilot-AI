"""The tasks a server runs for a client: created, polled, cancelled.

A task is findable before its handle is returned, its id is unguessable (it
is the only thing that names it: there is no ``tasks/list``), and a terminal
state never changes. ``failed`` is kept for a JSON-RPC error; a tool that
answers with ``isError`` completed.
"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from .wire import INTERNAL_ERROR, INVALID_PARAMS, TERMINAL_STATUSES, WireError

#: How long a finished task stays readable.
RETENTION_MS = 60 * 60 * 1000
#: The polling interval suggested to the client.
POLL_INTERVAL_MS = 2000
#: Tasks kept at once; a client that floods gets an error, not memory growth.
MAX_TASKS = 64


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, UTC).isoformat().replace("+00:00", "Z")


@dataclass
class _Entry:
    task_id: str
    created: float
    updated: float
    status: str = "working"
    status_message: str | None = None
    # Unlimited while it works; once terminal, the retention from now.
    ttl_ms: int | None = None
    result: dict[str, Any] | None = None
    error: dict[str, Any] | None = None
    job: asyncio.Task | None = field(default=None, repr=False)


class TaskStore:
    def __init__(
        self,
        *,
        retention_ms: int = RETENTION_MS,
        poll_interval_ms: int = POLL_INTERVAL_MS,
        max_tasks: int = MAX_TASKS,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._retention_ms = retention_ms
        self._poll_interval_ms = poll_interval_ms
        self._max_tasks = max_tasks
        self._clock = clock
        self._entries: dict[str, _Entry] = {}

    def start(
        self,
        run: Callable[[], Awaitable[dict[str, Any]]],
        *,
        status_message: str | None = None,
    ) -> dict[str, Any]:
        """Create a task running ``run`` and return its ``CreateTaskResult``."""
        self._purge()
        if len(self._entries) >= self._max_tasks:
            raise WireError(INTERNAL_ERROR, "too many tasks; wait for one to finish")
        now = self._clock()
        entry = _Entry(
            task_id=secrets.token_urlsafe(24),
            created=now,
            updated=now,
            status_message=status_message,
        )
        # Findable first, then started: a tasks/get right after the handle
        # always resolves.
        self._entries[entry.task_id] = entry
        entry.job = asyncio.get_running_loop().create_task(self._run(entry, run))
        return {**self._view(entry, detailed=False), "resultType": "task"}

    async def _run(
        self, entry: _Entry, run: Callable[[], Awaitable[dict[str, Any]]]
    ) -> None:
        try:
            result = await run()
        except asyncio.CancelledError:
            self._finish(entry, "cancelled")
            return
        except WireError as exc:
            self._finish(entry, "failed", error=exc.to_error(), message=exc.message)
            return
        except Exception as exc:  # noqa: BLE001 - a failed tool is a failed task
            self._finish(
                entry,
                "failed",
                error={
                    "code": INTERNAL_ERROR,
                    "message": str(exc) or type(exc).__name__,
                },
                message=str(exc) or type(exc).__name__,
            )
            return
        self._finish(entry, "completed", result=result)

    def _finish(
        self,
        entry: _Entry,
        status: str,
        *,
        result: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
        message: str | None = None,
    ) -> None:
        if entry.status in TERMINAL_STATUSES:
            return
        now = self._clock()
        entry.status = status
        entry.updated = now
        entry.result = result
        entry.error = error
        if message is not None:
            entry.status_message = message
        entry.ttl_ms = int((now - entry.created) * 1000) + self._retention_ms

    def get(self, task_id: Any) -> dict[str, Any]:
        return {
            **self._view(self._entry(task_id), detailed=True),
            "resultType": "complete",
        }

    def update(self, task_id: Any, input_responses: Any) -> dict[str, Any]:
        # These tasks never ask for input: there is no outstanding request a
        # response could answer, and one that names none is ignored.
        self._entry(task_id)
        return {"resultType": "complete"}

    def cancel(self, task_id: Any) -> dict[str, Any]:
        entry = self._entry(task_id)
        if entry.status not in TERMINAL_STATUSES:
            self._finish(entry, "cancelled", message="cancelled by the client")
            if entry.job is not None:
                entry.job.cancel()
        return {"resultType": "complete"}

    async def aclose(self) -> None:
        jobs = [e.job for e in self._entries.values() if e.job and not e.job.done()]
        for job in jobs:
            job.cancel()
        for job in jobs:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await job

    def _entry(self, task_id: Any) -> _Entry:
        self._purge()
        entry = self._entries.get(task_id) if isinstance(task_id, str) else None
        if entry is None:
            raise WireError(INVALID_PARAMS, "unknown or expired taskId")
        return entry

    def _purge(self) -> None:
        now = self._clock()
        for task_id, entry in list(self._entries.items()):
            if (
                entry.status in TERMINAL_STATUSES
                and entry.ttl_ms is not None
                and now * 1000 > entry.created * 1000 + entry.ttl_ms
            ):
                del self._entries[task_id]

    def _view(self, entry: _Entry, *, detailed: bool) -> dict[str, Any]:
        view: dict[str, Any] = {
            "taskId": entry.task_id,
            "status": entry.status,
            "createdAt": _iso(entry.created),
            "lastUpdatedAt": _iso(entry.updated),
            "ttlMs": entry.ttl_ms,
            "pollIntervalMs": self._poll_interval_ms,
        }
        if entry.status_message:
            view["statusMessage"] = entry.status_message
        if detailed and entry.status == "completed":
            view["result"] = entry.result or {}
        if detailed and entry.status == "failed":
            view["error"] = entry.error or {"code": INTERNAL_ERROR, "message": "failed"}
        return view
