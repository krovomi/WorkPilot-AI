"""Read-modify-write of a small JSON ledger shared by several processes.

The usage ledgers of a project (``.workpilot/cost_data.json``,
``dashboard_snapshot.json``, ``carbon-ledger.json``) are written by every agent
session of every task, and several tasks run at once, each in its own process.
A thread lock only serialises one process: two builds could read the same
version and the second write would drop the first one's record.

``update_json`` takes a lock file beside the ledger (created exclusively, so the
operating system arbitrates on every platform), reads, applies the change and
replaces the file atomically through a temporary file of its own. A lock left
by a killed process is taken over once it is older than ``STALE_AFTER_S``.
Telemetry never blocks a build: past ``WAIT_S`` the update proceeds without the
lock rather than waiting forever.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from pathlib import Path
from typing import Any

from foundation.file_utils import write_json_atomic

logger = logging.getLogger(__name__)

__all__ = ["STALE_AFTER_S", "WAIT_S", "process_lock", "update_json"]

#: How long a writer waits for the lock before writing without it.
WAIT_S = 5.0
#: A lock file older than this belongs to a process that died holding it.
STALE_AFTER_S = 30.0
_POLL_S = 0.02

_thread_locks: dict[str, threading.Lock] = {}
_thread_locks_mutex = threading.Lock()


def _thread_lock(path: Path) -> threading.Lock:
    key = str(path)
    with _thread_locks_mutex:
        return _thread_locks.setdefault(key, threading.Lock())


def _lock_path(path: Path) -> Path:
    return path.with_name(path.name + ".lock")


def _try_create(lock: Path) -> bool:
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return False
    os.close(fd)
    return True


def _is_stale(lock: Path) -> bool:
    try:
        return time.time() - lock.stat().st_mtime > STALE_AFTER_S
    except OSError:
        return False


@contextmanager
def process_lock(path: Path) -> Iterator[bool]:
    """Hold ``<path>.lock`` for the block; yields whether the lock was taken."""
    lock = _lock_path(path)
    deadline = time.monotonic() + WAIT_S
    held = False
    while True:
        try:
            held = _try_create(lock)
        except OSError as exc:  # read-only directory, odd filesystem
            logger.debug("[json_ledger] no lock for %s: %s", path, exc)
            break
        if held:
            break
        if _is_stale(lock):
            with suppress(OSError):
                lock.unlink()
            continue
        if time.monotonic() >= deadline:
            logger.debug("[json_ledger] lock wait timed out for %s", path)
            break
        time.sleep(_POLL_S)
    try:
        yield held
    finally:
        if held:
            with suppress(OSError):
                lock.unlink()


def update_json(
    path: Path,
    default: Callable[[], Any],
    change: Callable[[Any], Any],
) -> Any:
    """Apply ``change`` to the JSON at ``path`` under the lock; return what was written.

    ``default()`` stands for a missing or unreadable file. ``change`` receives
    the current value and returns the value to write (it may mutate in place
    and return it).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    with _thread_lock(path.resolve()), process_lock(path):
        try:
            current = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            current = default()
        updated = change(current)
        write_json_atomic(path, updated)
        return updated
