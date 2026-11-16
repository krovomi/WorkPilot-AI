"""
Merge Preview
=============

What merging a task would meet, before git and the AI merge run.

``core.workspace`` merges a task with git, then asks the user's provider for
each file both sides changed. Before that it reads here what the task changed
(``evolution_tracker.refresh_from_git``) and which of those changes collide
with another task's (``preview_merge``), so the user sees the conflicts first.
A merged task stops counting as one that can collide (``on_merge``).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from foundation.debug import (
    debug,
    debug_detailed,
    debug_section,
    debug_success,
    debug_verbose,
)

from .conflict_detector import ConflictDetector
from .file_evolution import FileEvolutionTracker
from .semantic_analyzer import SemanticAnalyzer
from .types import FileAnalysis

logger = logging.getLogger(__name__)
MODULE = "merge.preview"


class MergePreview:
    """What each task changed, and where two tasks' changes collide."""

    def __init__(self, project_dir: Path, storage_dir: Path | None = None):
        self.project_dir = Path(project_dir).resolve()
        self.storage_dir = storage_dir or (self.project_dir / ".workpilot")
        self.conflict_detector = ConflictDetector()
        self.evolution_tracker = FileEvolutionTracker(
            project_dir=self.project_dir,
            storage_dir=self.storage_dir,
            semantic_analyzer=SemanticAnalyzer(),
        )

    def preview_merge(
        self,
        task_ids: list[str],
    ) -> dict[str, Any]:
        """
        Preview what a merge would look like without executing.

        Args:
            task_ids: List of task IDs to preview merging

        Returns:
            Dictionary with preview information
        """
        debug_section(MODULE, "Preview Merge")
        debug(MODULE, "preview_merge() called", task_ids=task_ids)

        file_tasks = self.evolution_tracker.get_files_modified_by_tasks(task_ids)
        conflicting = self.evolution_tracker.get_conflicting_files(task_ids)

        debug(
            MODULE,
            "Files analysis",
            files_modified=len(file_tasks),
            files_with_conflicts=len(conflicting),
        )

        preview = {
            "tasks": task_ids,
            "files_to_merge": list(file_tasks.keys()),
            "files_with_potential_conflicts": conflicting,
            "conflicts": [],
        }

        # Analyze conflicts
        for file_path in conflicting:
            debug_detailed(MODULE, f"Analyzing conflicts for: {file_path}")
            # Named by the record, so it has one
            evolution = self.evolution_tracker.get_file_evolution(file_path)

            analyses = {}
            for snapshot in evolution.task_snapshots:
                if snapshot.task_id in task_ids:
                    analyses[snapshot.task_id] = FileAnalysis(
                        file_path=file_path,
                        changes=snapshot.semantic_changes,
                    )

            conflicts = self.conflict_detector.detect_conflicts(analyses)
            debug_detailed(MODULE, f"Found {len(conflicts)} conflicts in {file_path}")

            for c in conflicts:
                debug_verbose(
                    MODULE,
                    f"Conflict: {c.location}",
                    severity=c.severity.value,
                    can_auto_merge=c.can_auto_merge,
                )
                preview["conflicts"].append(
                    {
                        "file": c.file_path,
                        "location": c.location,
                        "tasks": c.tasks_involved,
                        "severity": c.severity.value,
                        "can_auto_merge": c.can_auto_merge,
                        "strategy": c.merge_strategy.value
                        if c.merge_strategy
                        else None,
                        "reason": c.reason,
                    }
                )

        preview["summary"] = {
            "total_files": len(file_tasks),
            "conflict_files": len(conflicting),
            "total_conflicts": len(preview["conflicts"]),
            "auto_mergeable": sum(
                1 for c in preview["conflicts"] if c["can_auto_merge"]
            ),
        }

        debug_success(MODULE, "Preview complete", summary=preview["summary"])

        return preview


def on_merge(event) -> None:
    """`core.merge_event` subscriber: a merged task no longer collides with others."""
    MergePreview(Path(event.project_dir)).evolution_tracker.mark_task_completed(
        event.spec_name
    )
