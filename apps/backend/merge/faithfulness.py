"""
Merge Faithfulness
==================

Did a deterministic merge keep what every task wrote?

The strategies place changes by pattern: a hook after a function's opening
brace, a method before a class's closing one, an import after the last import.
When a pattern does not match, the change has nowhere to go; and the semantic
analyzer does not see every edit (a changed function body yields no change at
all). A merge that reports itself as done would then hand the project a file
missing a task's work. So every line a task added, in its diff or in a change,
has to be in the merged file. A merge that dropped one is not written; it goes
to review, naming what is missing.
"""

from __future__ import annotations

from .types import TaskSnapshot


def _lines(text: str) -> list[str]:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n")
    return [line.strip() for line in normalized.split("\n") if line.strip()]


def _added_by_diff(raw_diff: str) -> list[str]:
    return _lines(
        "\n".join(
            line[1:]
            for line in raw_diff.replace("\r\n", "\n").split("\n")
            if line.startswith("+") and not line.startswith("+++")
        )
    )


def missing_changes(
    merged_content: str, task_snapshots: list[TaskSnapshot]
) -> list[tuple[str, str]]:
    """``(task_id, what)`` for each piece of a task's work not in the merge."""
    merged = "\n".join(_lines(merged_content))
    missing: list[tuple[str, str]] = []
    for snapshot in task_snapshots:
        for change in snapshot.semantic_changes:
            wanted = _lines(change.content_after or "")
            if wanted and not all(line in merged for line in wanted):
                missing.append(
                    (snapshot.task_id, f"{change.change_type.value} {change.target}")
                )
        lost = [
            line
            for line in _added_by_diff(snapshot.raw_diff or "")
            if line not in merged
        ]
        if lost:
            missing.append(
                (snapshot.task_id, f"{len(lost)} added line(s) from its diff")
            )
    return missing


def describe(missing: list[tuple[str, str]]) -> str:
    """One line naming what a merge left out, task by task."""
    parts = [f"{task_id}: {what}" for task_id, what in missing]
    return "Changes not placed by the automatic merge: " + "; ".join(parts)
