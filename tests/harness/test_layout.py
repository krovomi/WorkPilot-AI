"""harness.domain.layout: a prompt goes from the most stable segment to the least."""

from __future__ import annotations

import pytest
from harness.domain.layout import (
    LayoutError,
    Segment,
    Stability,
    assemble,
    ordered,
    shared_prefix,
)

RULES = Segment("rules", "rules.", Stability.STATIC)
SKILL = Segment("skill", " skill.", Stability.PROJECT)
PATH = Segment("path", " /work/task-1.", Stability.TASK)
SUBTASK = Segment("subtask", " subtask 3.", Stability.SESSION)


def test_segments_join_as_they_are_without_a_separator():
    assert assemble([RULES, SKILL, PATH]) == "rules. skill. /work/task-1."


def test_a_volatile_segment_before_a_stable_one_is_refused():
    with pytest.raises(
        LayoutError, match="'skill' \\(project\\) is placed after 'path'"
    ):
        assemble([RULES, PATH, SKILL])


@pytest.mark.parametrize(
    "segments",
    [
        [RULES, RULES],  # equal classes may follow each other
        [RULES, PATH],  # a class may be skipped
        [Segment("hint", "", Stability.STATIC), RULES],
        # An empty segment holds no place, so it constrains nothing.
        [RULES, PATH, Segment("late", "", Stability.STATIC), SUBTASK],
    ],
)
def test_orders_that_are_accepted(segments):
    assemble(segments)


def test_empty_segments_are_dropped():
    empty = Segment("hint", "", Stability.STATIC)
    assert ordered([empty, RULES, empty]) == [RULES]


@pytest.mark.parametrize(
    ("up_to", "expected"),
    [
        (Stability.STATIC, "rules."),
        (Stability.PROJECT, "rules. skill."),
        (Stability.TASK, "rules. skill. /work/task-1."),
        (Stability.TURN, "rules. skill. /work/task-1. subtask 3."),
    ],
)
def test_shared_prefix(up_to, expected):
    assert shared_prefix([RULES, SKILL, PATH, SUBTASK], up_to=up_to) == expected


def test_two_tasks_share_everything_before_their_first_task_segment():
    other = Segment("path", " /work/task-2.", Stability.TASK)
    first = assemble([RULES, SKILL, PATH])
    second = assemble([RULES, SKILL, other])
    common = shared_prefix([RULES, SKILL, PATH], up_to=Stability.PROJECT)
    assert first.startswith(common) and second.startswith(common)
    assert first[len(common) :] != second[len(common) :]
