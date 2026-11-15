"""
Merge Pipeline
==============

File-level merge orchestration logic.

This module handles the pipeline for merging a single file:
- Building task analyses from snapshots
- Detecting conflicts
- Determining merge strategy (single task vs. multi-task)
- Coordinating conflict resolution
"""

from __future__ import annotations

import logging

from .conflict_detector import ConflictDetector
from .conflict_resolver import ConflictResolver
from .faithfulness import describe, missing_changes
from .file_merger import combine_non_conflicting_changes
from .progress import MergeProgressCallback, MergeProgressStage
from .types import (
    ChangeType,
    FileAnalysis,
    MergeDecision,
    MergeResult,
    TaskSnapshot,
)

logger = logging.getLogger(__name__)


class MergePipeline:
    """
    Orchestrates the merge pipeline for individual files.

    This class handles the logic for merging changes from one or more
    tasks for a single file, coordinating conflict detection and resolution.
    """

    def __init__(
        self,
        conflict_detector: ConflictDetector,
        conflict_resolver: ConflictResolver,
    ):
        """
        Initialize the merge pipeline.

        Args:
            conflict_detector: ConflictDetector instance
            conflict_resolver: ConflictResolver instance
        """
        self.conflict_detector = conflict_detector
        self.conflict_resolver = conflict_resolver

    def merge_file(
        self,
        file_path: str,
        baseline_content: str,
        task_snapshots: list[TaskSnapshot],
        progress_callback: MergeProgressCallback | None = None,
    ) -> MergeResult:
        """
        Merge changes from multiple tasks for a single file.

        Args:
            file_path: Path to the file
            baseline_content: Original baseline content
            task_snapshots: Snapshots from tasks that modified this file
            progress_callback: Optional callback for emitting per-file progress
                within the 'resolving' stage (50-75% range)

        Returns:
            MergeResult with merged content or conflict info
        """
        logger.info(f"Merging {file_path} with {len(task_snapshots)} task(s)")

        if progress_callback:
            progress_callback(
                stage=MergeProgressStage.RESOLVING,
                percent=50,
                message=f"Merging file: {file_path}",
                details={"current_file": file_path},
            )

        # One task: its worktree file is the merge. The baseline is the file
        # as that task found it, so replaying its changes onto the baseline can
        # only reproduce the worktree version, or lose what a pattern missed.
        if len(task_snapshots) == 1:
            snapshot = task_snapshots[0]
            return MergeResult(
                decision=MergeDecision.DIRECT_COPY,
                file_path=file_path,
                merged_content=None,  # Caller must read from worktree
                explanation=f"Only {snapshot.task_id} changed this file - use its version",
            )

        # Multiple tasks - need conflict detection
        task_analyses = self._build_task_analyses(file_path, task_snapshots)

        # Detect conflicts
        conflicts = self.conflict_detector.detect_conflicts(task_analyses)

        if not conflicts:
            # No conflicts - combine all changes
            merged = combine_non_conflicting_changes(
                baseline_content, task_snapshots, file_path
            )
            return self._checked(
                MergeResult(
                    decision=MergeDecision.AUTO_MERGED,
                    file_path=file_path,
                    merged_content=merged,
                    explanation="All changes compatible, combined automatically",
                ),
                task_snapshots,
            )

        # Handle conflicts
        return self._checked(
            self.conflict_resolver.resolve_conflicts(
                file_path=file_path,
                baseline_content=baseline_content,
                task_snapshots=task_snapshots,
                conflicts=conflicts,
                progress_callback=progress_callback,
            ),
            task_snapshots,
        )

    @staticmethod
    def _checked(
        result: MergeResult, task_snapshots: list[TaskSnapshot]
    ) -> MergeResult:
        """A deterministic merge that left out a task's lines goes to review."""
        if result.decision != MergeDecision.AUTO_MERGED or not result.merged_content:
            return result
        missing = missing_changes(result.merged_content, task_snapshots)
        if missing:
            logger.warning(f"Automatic merge of {result.file_path} left out changes")
            result.decision = MergeDecision.NEEDS_HUMAN_REVIEW
            result.explanation = describe(missing)
        return result

    def _build_task_analyses(
        self,
        file_path: str,
        task_snapshots: list[TaskSnapshot],
    ) -> dict[str, FileAnalysis]:
        """
        Build FileAnalysis objects from task snapshots.

        Args:
            file_path: Path to the file
            task_snapshots: List of task snapshots

        Returns:
            Dictionary mapping task_id to FileAnalysis
        """
        analyses = {}
        for snapshot in task_snapshots:
            analysis = FileAnalysis(
                file_path=file_path,
                changes=snapshot.semantic_changes,
            )

            # Populate summary fields
            for change in snapshot.semantic_changes:
                if change.change_type == ChangeType.ADD_FUNCTION:
                    analysis.functions_added.add(change.target)
                elif change.change_type == ChangeType.MODIFY_FUNCTION:
                    analysis.functions_modified.add(change.target)
                elif change.change_type == ChangeType.ADD_IMPORT:
                    analysis.imports_added.add(change.target)
                elif change.change_type == ChangeType.REMOVE_IMPORT:
                    analysis.imports_removed.add(change.target)
                analysis.total_lines_changed += change.line_end - change.line_start + 1

            analyses[snapshot.task_id] = analysis

        return analyses
