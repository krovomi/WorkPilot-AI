"""The third stop condition: a model that repeats itself is not making progress.

A loop stops on its natural end (no tool call) and at ``max_turns``. Between
the two, a model can call the same tool with the same arguments, get the same
answer, and do it again — each turn paid in full, the whole conversation re-sent
— until ``max_turns`` ends it. The same calls with the same results several
turns in a row are a loop, whatever the provider: the model is told once, then
stopped.

A turn is compared by its fingerprint: every call's name, arguments and result.
A result that changes (a test that now passes, a file that now exists) is
progress, even when the call is the same.

Pure, table-tested in ``tests/harness/test_progress.py``.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Literal

REPEATS_BEFORE_NUDGE = 3
REPEATS_BEFORE_STOP = 5

Verdict = Literal["continue", "nudge", "stop"]

PROGRESS_NUDGE = (
    "You have made the same tool call(s) and received the same result(s) "
    f"{REPEATS_BEFORE_NUDGE} turns in a row. Repeating them will not change the "
    "result: change your approach, or finish and say what is blocking you."
)

NO_PROGRESS_STOP = (
    "The model made the same tool call(s) with the same result(s) "
    f"{REPEATS_BEFORE_STOP} turns in a row — stopping to avoid an endless loop."
)


def turn_fingerprint(calls: Iterable[tuple[str, Any, str]]) -> str:
    """One turn's tool calls — name, arguments, result — as a digest."""
    digest = hashlib.sha256()
    for name, arguments, result in calls:
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        digest.update(
            json.dumps(arguments, sort_keys=True, default=str).encode("utf-8")
        )
        digest.update(b"\0")
        digest.update(result.encode("utf-8", errors="replace"))
        digest.update(b"\1")
    return digest.hexdigest()


@dataclass
class ProgressTracker:
    """Counts identical turns in a row and says when to nudge, then to stop."""

    nudge_after: int = REPEATS_BEFORE_NUDGE
    stop_after: int = REPEATS_BEFORE_STOP
    _last: str | None = field(default=None, repr=False)
    _repeats: int = field(default=0, repr=False)
    _nudged: bool = field(default=False, repr=False)

    def observe(self, fingerprint: str) -> Verdict:
        """The verdict after a turn with tool calls."""
        if fingerprint == self._last:
            self._repeats += 1
        else:
            self._last = fingerprint
            self._repeats = 1
            self._nudged = False
        if self._repeats >= self.stop_after:
            return "stop"
        if self._repeats >= self.nudge_after and not self._nudged:
            self._nudged = True
            return "nudge"
        return "continue"
