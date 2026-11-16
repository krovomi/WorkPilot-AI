"""
What each task changed, read from its branch in git.

``refresh_from_git`` diffs a task's branch against the branch it left and
records, per file, the content before, the diff and its semantic changes
(``.workpilot/file_evolution.json``). The merge preview compares those records
between tasks; a task counts as active until it is merged
(``mark_task_completed``) and again once it is read anew.
"""

from __future__ import annotations

import logging
from datetime import datetime
from pathlib import Path

from foundation.debug import debug, debug_warning
from foundation.git_executable import run_git

from ..semantic_analyzer import SemanticAnalyzer
from ..types import FileEvolution, TaskSnapshot, compute_content_hash
from .storage import EvolutionStorage

logger = logging.getLogger(__name__)
MODULE = "merge.file_evolution"


class FileEvolutionTracker:
    """The recorded changes of each task, file by file."""

    def __init__(
        self,
        project_dir: Path,
        storage_dir: Path | None = None,
        semantic_analyzer: SemanticAnalyzer | None = None,
    ):
        self.project_dir = Path(project_dir).resolve()
        self.storage = EvolutionStorage(
            self.project_dir, storage_dir or (self.project_dir / ".workpilot")
        )
        self.analyzer = semantic_analyzer or SemanticAnalyzer()
        self._evolutions: dict[str, FileEvolution] = self.storage.load_evolutions()

    def get_file_evolution(self, file_path: Path | str) -> FileEvolution | None:
        """The record of one file, if a task changed it."""
        return self._evolutions.get(self.storage.get_relative_path(file_path))

    def get_files_modified_by_tasks(self, task_ids: list[str]) -> dict[str, list[str]]:
        """Each file the given tasks changed, with the tasks that changed it."""
        file_tasks: dict[str, list[str]] = {}
        for file_path, evolution in self._evolutions.items():
            for snapshot in evolution.task_snapshots:
                if snapshot.task_id in task_ids and snapshot.has_modifications:
                    file_tasks.setdefault(file_path, []).append(snapshot.task_id)
        return file_tasks

    def get_conflicting_files(self, task_ids: list[str]) -> list[str]:
        """The files two or more of the given tasks changed."""
        return [
            file_path
            for file_path, tasks in self.get_files_modified_by_tasks(task_ids).items()
            if len(tasks) > 1
        ]

    def get_active_tasks(self) -> set[str]:
        """The tasks recorded and not merged since."""
        return {
            snapshot.task_id
            for evolution in self._evolutions.values()
            for snapshot in evolution.task_snapshots
            if snapshot.completed_at is None
        }

    def mark_task_completed(self, task_id: str) -> None:
        """The task was merged: its changes no longer collide with others."""
        now = datetime.now()
        for evolution in self._evolutions.values():
            snapshot = evolution.get_task_snapshot(task_id)
            if snapshot and snapshot.completed_at is None:
                snapshot.completed_at = now
        self.storage.save_evolutions(self._evolutions)

    def refresh_from_git(
        self,
        task_id: str,
        worktree_path: Path,
        target_branch: str | None = None,
        analyze_only_files: set[str] | None = None,
    ) -> None:
        """Record what ``task_id`` changed in ``worktree_path``.

        Args:
            task_id: The task identifier
            worktree_path: Path to the task's worktree
            target_branch: Branch the task left (default: main, master or develop)
            analyze_only_files: When given, only these files get a semantic
                analysis; the others are recorded with their diff alone.
        """
        target_branch = target_branch or self._detect_target_branch(worktree_path)
        debug(
            MODULE,
            f"refresh_from_git() for task {task_id}",
            target_branch=target_branch,
        )

        # Every git call reads UTF-8 and replaces what is not: one file in
        # another encoding must not stop the others from being recorded.
        merge_base_result = run_git(
            ["merge-base", target_branch, "HEAD"], worktree_path
        )
        if merge_base_result.returncode != 0:
            logger.error(
                f"Failed to refresh from git: no merge-base with {target_branch}: "
                f"{merge_base_result.stderr.strip()}"
            )
            return
        merge_base = merge_base_result.stdout.strip()

        # Names NUL-separated: git does not quote a name with non-ASCII
        # characters there, so it is the file on disk.
        result = run_git(
            ["diff", "--name-only", "-z", f"{merge_base}..HEAD"], worktree_path
        )
        if result.returncode != 0:
            logger.error(f"Failed to refresh from git: {result.stderr.strip()}")
            return
        changed_files = [f for f in result.stdout.split("\0") if f]

        for file_path in changed_files:
            diff_result = run_git(
                ["diff", f"{merge_base}..HEAD", "--", file_path], worktree_path
            )
            if diff_result.returncode != 0:
                logger.warning(
                    f"Failed to read the diff of {file_path}: {diff_result.stderr.strip()}"
                )
                continue

            # Content before: the file at the merge-base, or nothing if it is new
            show_result = run_git(["show", f"{merge_base}:{file_path}"], worktree_path)
            old_content = show_result.stdout if show_result.returncode == 0 else ""
            current_file = worktree_path / file_path
            new_content = (
                current_file.read_text(encoding="utf-8", errors="replace")
                if current_file.exists()
                else ""
            )

            rel_path = self.storage.get_relative_path(file_path)
            analyze = analyze_only_files is None or rel_path in analyze_only_files
            self._record(
                task_id,
                rel_path,
                merge_base,
                old_content,
                new_content,
                diff_result.stdout,
                analyze,
            )

        self.storage.save_evolutions(self._evolutions)
        logger.info(f"Recorded {len(changed_files)} files for task {task_id}")

    def _record(
        self,
        task_id: str,
        rel_path: str,
        merge_base: str,
        old_content: str,
        new_content: str,
        raw_diff: str,
        analyze: bool,
    ) -> None:
        evolution = self._evolutions.get(rel_path)
        if evolution is None:
            evolution = self._evolutions[rel_path] = FileEvolution(
                file_path=rel_path,
                baseline_commit=merge_base,
                baseline_captured_at=datetime.now(),
                baseline_content_hash=compute_content_hash(old_content),
                baseline_snapshot_path="",
                task_snapshots=[],
            )
        snapshot = evolution.get_task_snapshot(task_id) or TaskSnapshot(
            task_id=task_id,
            task_intent="",
            started_at=datetime.now(),
            content_hash_before=compute_content_hash(old_content),
        )
        snapshot.semantic_changes = (
            self.analyzer.analyze_diff(rel_path, old_content, new_content).changes
            if analyze
            else []
        )
        # Pending again until the task is merged
        snapshot.completed_at = None
        snapshot.content_hash_after = compute_content_hash(new_content)
        snapshot.raw_diff = raw_diff
        evolution.add_task_snapshot(snapshot)

    def _detect_target_branch(self, worktree_path: Path) -> str:
        """The first of main, master and develop the worktree shares history with."""
        for branch in ["main", "master", "develop"]:
            if run_git(["merge-base", branch, "HEAD"], worktree_path).returncode == 0:
                return branch
        debug_warning(
            MODULE, "No standard base branch found", worktree_path=str(worktree_path)
        )
        return "HEAD~10"
