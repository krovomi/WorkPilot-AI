"""How many times in a row the guard may close the thread on one piece of work.

A reset ("context_reset") re-runs the same subtask, or the same planning, on a
compacted or fresh thread. When that thread is already near the threshold from
its first turns — a window too small for the prompt itself, typically a local
model — every session is cut at its first safe point and the work never
advances. Past ``MAX_CONSECUTIVE_RESETS`` the next sessions on that work only
measure: the gauge keeps moving, but nothing closes the thread any more, as if
the guard had failed (best-effort: never a stuck build).
"""

from __future__ import annotations

MAX_CONSECUTIVE_RESETS = 3


class ResetBudget:
    """Consecutive resets of the current piece of work. One per build loop."""

    def __init__(self, limit: int = MAX_CONSECUTIVE_RESETS) -> None:
        self.limit = limit
        self._work: object = None
        self._count = 0

    def exhausted(self, work: object) -> bool:
        """Whether the next session on ``work`` should only measure.

        Called before each session; another piece of work starts a fresh budget.
        """
        if work != self._work:
            self._work, self._count = work, 0
        return self._count >= self.limit

    def record(self, status: str) -> bool:
        """Count a session's status. True when this reset spends the budget.

        Any other status ends the run of resets.
        """
        if status != "context_reset":
            self._count = 0
            return False
        self._count += 1
        return self._count == self.limit


def budget_spent_message(work: str, limit: int = MAX_CONSECUTIVE_RESETS) -> str:
    """The log line for a spent budget."""
    return (
        f"Context management paused for {work}: the thread was reset {limit} "
        "times in a row without finishing it. The next sessions only measure."
    )
