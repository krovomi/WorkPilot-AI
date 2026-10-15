"""harness.domain.policies: clear old tool results in batches, never a little each turn."""

from __future__ import annotations

import pytest
from harness.domain.policies import ClearingPolicy, Entry, plan_clearing

MARKER = 10
POLICY = ClearingPolicy(trigger_chars=1_000, target_chars=600, keep_recent=2)


def _tool(chars: int) -> Entry:
    return Entry(chars, clearable=True)


def _other(chars: int) -> Entry:
    return Entry(chars, clearable=False)


def test_under_the_trigger_nothing_is_cleared():
    entries = [_other(100), _tool(400), _tool(400)]
    assert plan_clearing(entries, POLICY, marker_chars=MARKER) == []


def test_over_the_trigger_the_oldest_results_go_down_to_the_target():
    entries = [_other(100), _tool(300), _tool(300), _tool(300), _tool(50), _tool(50)]
    # 1,100 over 1,000: two results go (to ~520), not one (to ~810).
    assert plan_clearing(entries, POLICY, marker_chars=MARKER) == [1, 2]


@pytest.mark.parametrize(
    ("entries", "expected"),
    [
        # Only tool results go, whatever their size.
        ([_other(900), _tool(300), _other(10), _other(10)], [1]),
        # The latest keep_recent messages stay, even when they are the bulk.
        ([_other(10), _tool(100), _tool(900), _tool(900)], [1]),
        # A result no longer than its marker is not worth replacing.
        ([_tool(MARKER), _tool(1_200), _other(1), _other(1)], [1]),
        # Nothing old enough: nothing to do.
        ([_tool(2_000), _tool(2_000)], []),
    ],
)
def test_what_may_go(entries, expected):
    assert plan_clearing(entries, POLICY, marker_chars=MARKER) == expected


def test_a_clearing_that_frees_less_than_its_minimum_is_skipped():
    policy = ClearingPolicy(1_000, 600, keep_recent=2, min_gain_chars=500)
    entries = [_tool(200), _other(900), _other(10), _other(10)]
    assert plan_clearing(entries, policy, marker_chars=MARKER) == []
    entries = [_tool(800), _other(900), _other(10), _other(10)]
    assert plan_clearing(entries, policy, marker_chars=MARKER) == [0]


def test_for_budget():
    policy = ClearingPolicy.for_budget(300_000, keep_recent=8)
    assert policy == ClearingPolicy(300_000, 180_000, 8, 30_000)


def test_an_entry_that_keeps_part_of_itself_counts_only_what_goes():
    # A past call loses its long arguments, not itself: 900 chars, 100 kept.
    entries = [
        Entry(900, clearable=True, cleared_chars=100),
        _other(300),
        _other(1),
        _other(1),
    ]
    assert plan_clearing(entries, POLICY, marker_chars=MARKER) == [0]
    # Nothing to gain when what it keeps is all it has.
    entries = [
        Entry(900, clearable=True, cleared_chars=900),
        _other(300),
        _other(1),
        _other(1),
    ]
    assert plan_clearing(entries, POLICY, marker_chars=MARKER) == []
