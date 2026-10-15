"""harness.domain.progress: the same calls with the same results are a loop."""

from __future__ import annotations

import pytest
from harness.domain.progress import (
    REPEATS_BEFORE_NUDGE,
    REPEATS_BEFORE_STOP,
    ProgressTracker,
    turn_fingerprint,
)

READ = [("read_file", {"path": "a.py"}, "x = 1\n")]


def test_a_fingerprint_covers_name_arguments_and_result():
    base = turn_fingerprint(READ)
    assert base == turn_fingerprint([("read_file", {"path": "a.py"}, "x = 1\n")])
    assert base != turn_fingerprint([("read_file", {"path": "b.py"}, "x = 1\n")])
    assert base != turn_fingerprint([("read_file", {"path": "a.py"}, "x = 2\n")])
    assert base != turn_fingerprint([("search_files", {"path": "a.py"}, "x = 1\n")])
    assert base != turn_fingerprint(READ * 2)


def test_argument_order_does_not_matter():
    assert turn_fingerprint([("f", {"a": 1, "b": 2}, "r")]) == turn_fingerprint(
        [("f", {"b": 2, "a": 1}, "r")]
    )


def test_the_same_turn_is_nudged_once_then_stopped():
    tracker = ProgressTracker()
    fingerprint = turn_fingerprint(READ)
    verdicts = [tracker.observe(fingerprint) for _ in range(REPEATS_BEFORE_STOP)]
    assert verdicts == (
        ["continue"] * (REPEATS_BEFORE_NUDGE - 1)
        + ["nudge"]
        + ["continue"] * (REPEATS_BEFORE_STOP - REPEATS_BEFORE_NUDGE - 1)
        + ["stop"]
    )


@pytest.mark.parametrize(
    ("sequence", "last"),
    [
        # A changed result is progress: the count starts over.
        (["a", "a", "b", "b", "b", "b"], "continue"),
        (["a", "a", "b", "a", "a", "a", "a"], "continue"),
        (["a", "b", "b", "b"], "nudge"),
        (["a", "a", "a", "a", "a"], "stop"),
    ],
)
def test_only_consecutive_repeats_count(sequence, last):
    tracker = ProgressTracker()
    assert [tracker.observe(f) for f in sequence][-1] == last


def test_a_new_loop_after_a_change_is_nudged_again():
    tracker = ProgressTracker()
    first = [tracker.observe("a") for _ in range(3)]
    tracker.observe("b")
    second = [tracker.observe("a") for _ in range(3)]
    assert first[-1] == "nudge" and second[-1] == "nudge"
