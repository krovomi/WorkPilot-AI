"""The machine's queue of suites, shared by every build on it.

Each build that wants to run a suite here holds a ticket: one small file in
``~/.workpilot/suite-queue/`` (every project of the machine shares it), named
by the time it was taken so the names sort in arrival order. A ticket is
``waiting`` or ``running``; one whose process is gone is removed by the next
reader, so a crashed build never holds the queue.

A waiting build may run when the machine has room (``decide``), or when it is
its turn: no other suite running here and no older waiting ticket. So the
queue always moves, one suite after another at worst.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass
from pathlib import Path

from foundation.platform import pid_is_running

__all__ = ["QUEUE_ENV", "Ticket", "queue_dir"]

logger = logging.getLogger(__name__)

#: Another folder for the queue (tests, a deployment with its own home).
QUEUE_ENV = "WORKPILOT_SUITE_QUEUE_DIR"


def queue_dir() -> Path:
    override = os.environ.get(QUEUE_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    return Path.home() / ".workpilot" / "suite-queue"


@dataclass(frozen=True)
class _Entry:
    path: Path
    pid: int
    state: str


def _entries(root: Path) -> list[_Entry]:
    """The live tickets, oldest first; dead ones are removed on the way."""
    entries: list[_Entry] = []
    try:
        paths = sorted(root.glob("*.json"))
    except OSError:
        return entries
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        pid = data.get("pid") if isinstance(data, dict) else None
        state = data.get("state") if isinstance(data, dict) else None
        if not isinstance(pid, int) or state not in ("waiting", "running"):
            continue
        if not pid_is_running(pid):
            path.unlink(missing_ok=True)
            continue
        entries.append(_Entry(path, pid, state))
    return entries


class Ticket:
    """This build's place in the queue; ``with Ticket() as ticket``."""

    def __init__(self, label: str = "", root: Path | None = None):
        self._root = root or queue_dir()
        self._label = label[:120]
        self._pid = os.getpid()
        self.path: Path | None = None
        self.state = "waiting"

    def _write(self) -> None:
        if self.path is None:
            return
        try:
            self.path.write_text(
                json.dumps(
                    {"pid": self._pid, "state": self.state, "label": self._label}
                ),
                encoding="utf-8",
            )
        except OSError as exc:
            logger.warning("suite queue ticket not written: %s", exc)

    def __enter__(self) -> Ticket:
        try:
            self._root.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.warning("suite queue unavailable (%s): the suite runs unqueued", exc)
            return self
        self.path = self._root / f"{time.time_ns():020d}-{self._pid}.json"
        self._write()
        return self

    def __exit__(self, *_exc: object) -> None:
        self.release()

    def release(self) -> None:
        if self.path is not None:
            self.path.unlink(missing_ok=True)
            self.path = None

    def mark_running(self) -> None:
        self.state = "running"
        self._write()

    def others_running(self) -> int:
        return sum(
            1
            for entry in _entries(self._root)
            if entry.state == "running" and entry.path != self.path
        )

    def my_turn(self) -> bool:
        """No other suite runs here and no older ticket waits."""
        if self.path is None:
            return True
        mine = self.path.name
        for entry in _entries(self._root):
            if entry.path == self.path:
                continue
            if entry.state == "running" or entry.path.name < mine:
                return False
        return True
