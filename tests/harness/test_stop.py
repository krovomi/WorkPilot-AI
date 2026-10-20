"""When the WorkPilot loop stops (``harness.domain.stop``), by table."""

from __future__ import annotations

import pytest
from harness.domain.stop import stop_reason


@pytest.mark.parametrize(
    ("turns", "max_turns", "done", "progress", "expected"),
    [
        # Before the first turn: only an empty budget stops.
        (0, 50, False, "continue", None),
        (0, 0, False, "continue", "max_turns"),
        # A turn that went through, with turns left.
        (1, 50, False, "continue", None),
        (3, 50, False, "nudge", None),
        # The three reasons.
        (4, 50, True, "continue", "natural_end"),
        (5, 50, False, "stop", "no_progress"),
        (50, 50, False, "continue", "max_turns"),
        (50, 50, False, "nudge", "max_turns"),
        # On the last turn, finishing is finishing, and a loop is a loop:
        # neither ran out of turns.
        (50, 50, True, "continue", "natural_end"),
        (50, 50, False, "stop", "no_progress"),
    ],
)
def test_stop_reason(turns, max_turns, done, progress, expected):
    assert (
        stop_reason(turns=turns, max_turns=max_turns, done=done, progress=progress)
        == expected
    )
