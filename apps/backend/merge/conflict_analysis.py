"""
Conflict Analysis
=================

Core logic for detecting and analyzing conflicts between task changes.

This module contains:
- Conflict detection algorithms
- Severity assessment logic
- Implicit conflict detection
- Range overlap checking
"""

from __future__ import annotations

import logging
from collections import defaultdict

from .compatibility_rules import CompatibilityRule
from .types import (
    ChangeType,
    ConflictRegion,
    ConflictSeverity,
    FileAnalysis,
    MergeStrategy,
    SemanticChange,
)

# Import debug utilities
try:
    from foundation.debug import debug, debug_detailed, debug_verbose
except ImportError:

    def debug(*args, **kwargs):
        pass

    def debug_detailed(*args, **kwargs):
        pass

    def debug_verbose(*args, **kwargs):
        pass


logger = logging.getLogger(__name__)
MODULE = "merge.conflict_analysis"


def detect_conflicts(
    task_analyses: dict[str, FileAnalysis],
    rule_index: dict[tuple[ChangeType, ChangeType], CompatibilityRule],
) -> list[ConflictRegion]:
    """
    Detect conflicts between multiple task changes to the same file.

    Args:
        task_analyses: Map of task_id -> FileAnalysis
        rule_index: Indexed compatibility rules for fast lookup

    Returns:
        List of detected conflict regions
    """
    task_ids = list(task_analyses.keys())
    debug(
        MODULE,
        f"Detecting conflicts between {len(task_analyses)} tasks",
        tasks=task_ids,
    )

    if len(task_analyses) <= 1:
        debug(MODULE, "No conflicts possible with 0-1 tasks")
        return []  # No conflicts possible with 0-1 tasks

    conflicts: list[ConflictRegion] = []

    # Changes meet when they touch the same thing at the same place: a task
    # that adds one import does not meet a task that removes another.
    groups: dict[tuple[str, str], list[tuple[str, SemanticChange]]] = defaultdict(list)

    for task_id, analysis in task_analyses.items():
        debug_detailed(
            MODULE,
            f"Processing task {task_id}",
            changes_count=len(analysis.changes),
            file=analysis.file_path,
        )
        for change in analysis.changes:
            groups[(change.location, change.target)].append((task_id, change))

    debug_detailed(MODULE, f"Grouped changes into {len(groups)} targets")

    file_path = next(iter(task_analyses.values())).file_path
    for (location, _target), task_changes in groups.items():
        # One task moving its own line (a removal and an addition of the same
        # import) is not a conflict: a conflict takes two tasks.
        if len({task_id for task_id, _ in task_changes}) <= 1:
            continue

        debug_verbose(
            MODULE,
            f"Checking location {location}",
            task_changes_count=len(task_changes),
        )

        conflict = analyze_location_conflict(
            file_path, location, task_changes, rule_index
        )
        if conflict:
            debug_detailed(
                MODULE,
                f"Conflict detected at {location}",
                severity=conflict.severity.value,
                can_auto_merge=conflict.can_auto_merge,
                tasks=conflict.tasks_involved,
            )
            conflicts.append(conflict)

    return conflicts


def analyze_location_conflict(
    file_path: str,
    location: str,
    task_changes: list[tuple[str, SemanticChange]],
    rule_index: dict[tuple[ChangeType, ChangeType], CompatibilityRule],
) -> ConflictRegion | None:
    """
    Analyze changes at a specific location for conflicts.

    Args:
        file_path: Path to the file being analyzed
        location: Location identifier (e.g., "function:main")
        task_changes: List of (task_id, change) tuples for this location
        rule_index: Indexed compatibility rules

    Returns:
        ConflictRegion if conflicts exist, None otherwise
    """
    tasks = list(dict.fromkeys(tc[0] for tc in task_changes))
    changes = [tc[1] for tc in task_changes]
    change_types = [c.change_type for c in changes]

    # Check pairwise compatibility, between changes of different tasks
    all_compatible = True
    final_strategy: MergeStrategy | None = None
    reasons = []

    for i, (task_a, change_a) in enumerate(task_changes):
        for task_b, change_b in task_changes[i + 1 :]:
            if task_a == task_b:
                continue
            type_a, type_b = change_a.change_type, change_b.change_type
            rule = rule_index.get((type_a, type_b))

            if rule:
                if not rule.compatible:
                    all_compatible = False
                    reasons.append(rule.reason)
                elif rule.strategy:
                    final_strategy = rule.strategy
            else:
                # No rule - conservative default
                all_compatible = False
                reasons.append(f"No rule for {type_a.value} + {type_b.value}")

    # Determine severity
    if all_compatible:
        severity = ConflictSeverity.NONE
    else:
        severity = assess_severity(change_types, changes)

    return ConflictRegion(
        file_path=file_path,
        location=location,
        tasks_involved=tasks,
        change_types=change_types,
        severity=severity,
        can_auto_merge=all_compatible,
        merge_strategy=final_strategy if all_compatible else MergeStrategy.AI_REQUIRED,
        reason=" | ".join(reasons) if reasons else "Changes are compatible",
    )


def assess_severity(
    change_types: list[ChangeType],
    changes: list[SemanticChange],
) -> ConflictSeverity:
    """
    Assess the severity of a conflict.

    Args:
        change_types: List of change types involved
        changes: List of semantic changes

    Returns:
        Assessed conflict severity level
    """
    # Critical: Both tasks modify core logic
    modify_types = {
        ChangeType.MODIFY_FUNCTION,
        ChangeType.MODIFY_METHOD,
        ChangeType.MODIFY_CLASS,
    }
    modify_count = sum(1 for ct in change_types if ct in modify_types)

    if modify_count >= 2:
        # Check if they modify the exact same lines
        line_ranges = [(c.line_start, c.line_end) for c in changes]
        if ranges_overlap(line_ranges):
            return ConflictSeverity.CRITICAL

    # High: Structural changes that could break compilation
    structural_types = {
        ChangeType.WRAP_JSX,
        ChangeType.UNWRAP_JSX,
        ChangeType.REMOVE_FUNCTION,
        ChangeType.REMOVE_CLASS,
    }
    if any(ct in structural_types for ct in change_types):
        return ConflictSeverity.HIGH

    # Medium: Modifications to same function/method
    if modify_count >= 1:
        return ConflictSeverity.MEDIUM

    # Low: Likely resolvable with AI
    return ConflictSeverity.LOW


def ranges_overlap(ranges: list[tuple[int, int]]) -> bool:
    """
    Check if any line ranges overlap.

    Args:
        ranges: List of (start_line, end_line) tuples

    Returns:
        True if any ranges overlap, False otherwise
    """
    sorted_ranges = sorted(ranges)
    for i in range(len(sorted_ranges) - 1):
        if sorted_ranges[i][1] >= sorted_ranges[i + 1][0]:
            return True
    return False
