"""When two tasks' changes to one file are a conflict.

Two changes meet when they touch the same thing at the same place, and a
conflict takes two tasks: one task moving its own import is not one.
"""

from __future__ import annotations

import pytest
from merge.conflict_detector import ConflictDetector
from merge.types import (
    ChangeType,
    ConflictSeverity,
    FileAnalysis,
    MergeStrategy,
    SemanticChange,
)


def change(kind, target, location="file_top", start=1, end=1):
    return SemanticChange(
        change_type=kind,
        target=target,
        location=location,
        line_start=start,
        line_end=end,
        content_after=target if kind.value.startswith("add") else None,
        content_before=None if kind.value.startswith("add") else target,
    )


def detect(**changes_by_task):
    return ConflictDetector().detect_conflicts(
        {
            task_id: FileAnalysis(file_path="src/app.py", changes=list(changes))
            for task_id, changes in changes_by_task.items()
        }
    )


def test_a_task_that_moves_its_own_import_meets_no_one():
    conflicts = detect(
        t1=[
            change(ChangeType.REMOVE_IMPORT, "import os", start=3, end=3),
            change(ChangeType.ADD_IMPORT, "import os", start=1, end=1),
        ],
        t2=[change(ChangeType.MODIFY_FUNCTION, "main", "function:main", 10, 14)],
    )
    assert conflicts == []


def test_an_unrelated_import_does_not_hide_a_conflict_on_another():
    alone = detect(
        t1=[change(ChangeType.REMOVE_IMPORT, "import os")],
        t2=[change(ChangeType.REMOVE_IMPORT, "import os")],
    )
    with_a_third = detect(
        t1=[change(ChangeType.REMOVE_IMPORT, "import os")],
        t2=[change(ChangeType.REMOVE_IMPORT, "import os")],
        t3=[change(ChangeType.ADD_IMPORT, "import json")],
    )

    assert [(c.location, c.tasks_involved) for c in alone] == [
        ("file_top", ["t1", "t2"])
    ]
    assert [(c.location, c.tasks_involved) for c in with_a_third] == [
        ("file_top", ["t1", "t2"])
    ]


def test_each_task_is_named_once_however_many_changes_it_made():
    conflicts = detect(
        t1=[
            change(ChangeType.REMOVE_IMPORT, "import os"),
            change(ChangeType.ADD_IMPORT, "import os"),
        ],
        t2=[change(ChangeType.REMOVE_IMPORT, "import os")],
    )
    assert [c.tasks_involved for c in conflicts] == [["t1", "t2"]]


def test_two_imports_of_the_same_line_combine():
    (conflict,) = detect(
        t1=[change(ChangeType.ADD_IMPORT, "import os")],
        t2=[change(ChangeType.ADD_IMPORT, "import os")],
    )
    assert conflict.can_auto_merge is True
    assert conflict.severity == ConflictSeverity.NONE
    assert conflict.merge_strategy == MergeStrategy.COMBINE_IMPORTS


@pytest.mark.parametrize(
    ("ranges", "severity"),
    [
        (((10, 14), (12, 20)), ConflictSeverity.CRITICAL),
        (((10, 14), (30, 40)), ConflictSeverity.MEDIUM),
    ],
)
def test_two_rewrites_of_a_function_are_critical_only_where_lines_meet(
    ranges, severity
):
    (first, second) = ranges
    (conflict,) = detect(
        t1=[change(ChangeType.MODIFY_FUNCTION, "main", "function:main", *first)],
        t2=[change(ChangeType.MODIFY_FUNCTION, "main", "function:main", *second)],
    )
    assert conflict.can_auto_merge is False
    assert conflict.merge_strategy == MergeStrategy.AI_REQUIRED
    assert conflict.severity == severity


def test_removing_a_function_another_task_rewrites_is_high():
    (conflict,) = detect(
        t1=[change(ChangeType.REMOVE_FUNCTION, "main", "function:main")],
        t2=[change(ChangeType.ADD_COMMENT, "main", "function:main")],
    )
    assert conflict.severity == ConflictSeverity.HIGH
    assert conflict.can_auto_merge is False


def test_two_different_imports_are_not_a_conflict():
    assert (
        detect(
            t1=[change(ChangeType.ADD_IMPORT, "import os")],
            t2=[change(ChangeType.ADD_IMPORT, "import json")],
        )
        == []
    )


def test_one_task_has_no_conflict():
    assert detect(t1=[change(ChangeType.ADD_IMPORT, "import os")]) == []
