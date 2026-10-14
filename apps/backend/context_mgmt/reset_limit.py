"""A cap on the context resets of one unit of work in a row.

The guard cuts a session past the task's threshold, and the build loop re-runs
the same subtask on what the guard left to replay. On a model whose window
barely holds a fresh thread (Ollama or LM Studio with an 8k-16k ``num_ctx``
under the coder prompt), every re-run starts past the threshold again and is
cut at its first safe point: the subtask never moves and the loop never ends.

``ResetLimit`` counts the resets of one unit in a row. Past the cap, the rest of
that unit runs with a guard that only measures: the fail-open the guard
promises, "no context management for this session, never a failed session".
"""

from __future__ import annotations

from collections.abc import Hashable

MAX_CONSECUTIVE_RESETS = 3

_UNSET = object()


class ResetLimit:
    """Per build loop. ``unit`` is what one reset must not loop on: the phase,
    the subtask and the model (another model has another window)."""

    def __init__(self, cap: int = MAX_CONSECUTIVE_RESETS) -> None:
        self.cap = cap
        self._unit: object = _UNSET
        self._streak = 0
        self._monitor_only = False

    def _enter(self, unit: Hashable) -> None:
        if unit != self._unit:
            self._unit, self._streak, self._monitor_only = unit, 0, False

    def monitor_only(self, unit: Hashable) -> bool:
        """Whether the next session of ``unit`` may only measure."""
        self._enter(unit)
        return self._monitor_only

    def record(self, unit: Hashable, status: str) -> bool:
        """Count a session's outcome. True once, when ``unit`` falls back."""
        self._enter(unit)
        if status != "context_reset":
            # A session that ended any other way: the resets before it were
            # not a loop. A unit that fell back stays so until it changes.
            self._streak = 0
            return False
        self._streak += 1
        if self._monitor_only or self._streak < self.cap:
            return False
        self._monitor_only = True
        return True

    def notice(self, what: str) -> str:
        """The one log line for a fallback."""
        return (
            f"🧠 Context reset {self.cap} times in a row on {what}: automatic "
            "compact/clear is off for the rest of it (the gauge keeps "
            "measuring). The model's window barely holds a fresh thread here; "
            "a larger window or a higher threshold gives it room."
        )
