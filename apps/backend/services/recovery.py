"""
Attempt history and good commits of a build, across its sessions.

What the coder and the session loop keep between sessions: each attempt at a
subtask (`memory/attempt_history.json`), the hints the next attempt reads,
the subtasks marked stuck for a person, and each commit a subtask ended on
(`memory/build_commits.json`, which the review groups by subtask).
"""

import json
from datetime import datetime
from pathlib import Path

from foundation.subtask_unblock import block


class RecoveryManager:
    """
    Keeps a build's attempts and good commits across sessions.

    Responsibilities:
    - Track attempt history across sessions, and hint the next attempt
    - Record the commit each subtask ended on
    - Mark stuck subtasks for human intervention (and blocked in the plan)
    """

    def __init__(self, spec_dir: Path, project_dir: Path):
        """
        Initialize recovery manager.

        Args:
            spec_dir: Spec directory containing memory/
            project_dir: Root project directory for git operations
        """
        self.spec_dir = spec_dir
        self.project_dir = project_dir
        self.memory_dir = spec_dir / "memory"
        self.attempt_history_file = self.memory_dir / "attempt_history.json"
        self.build_commits_file = self.memory_dir / "build_commits.json"

        # Ensure memory directory exists
        self.memory_dir.mkdir(parents=True, exist_ok=True)

        # Initialize files if they don't exist
        if not self.attempt_history_file.exists():
            self._init_attempt_history()

        if not self.build_commits_file.exists():
            self._init_build_commits()

    def _init_attempt_history(self) -> None:
        """Initialize the attempt history file."""
        initial_data = {
            "subtasks": {},
            "stuck_subtasks": [],
            "metadata": {
                "created_at": datetime.now().isoformat(),
                "last_updated": datetime.now().isoformat(),
            },
        }
        with open(self.attempt_history_file, "w", encoding="utf-8") as f:
            json.dump(initial_data, f, indent=2)

    def _init_build_commits(self) -> None:
        """Initialize the build commits tracking file."""
        initial_data = {
            "commits": [],
            "last_good_commit": None,
            "metadata": {
                "created_at": datetime.now().isoformat(),
                "last_updated": datetime.now().isoformat(),
            },
        }
        with open(self.build_commits_file, "w", encoding="utf-8") as f:
            json.dump(initial_data, f, indent=2)

    def _load_attempt_history(self) -> dict:
        """Load attempt history from JSON file."""
        try:
            with open(self.attempt_history_file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            self._init_attempt_history()
            with open(self.attempt_history_file, encoding="utf-8") as f:
                return json.load(f)

    def _save_attempt_history(self, data: dict) -> None:
        """Save attempt history to JSON file."""
        data["metadata"]["last_updated"] = datetime.now().isoformat()
        with open(self.attempt_history_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def _load_build_commits(self) -> dict:
        """Load build commits from JSON file."""
        try:
            with open(self.build_commits_file, encoding="utf-8") as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            self._init_build_commits()
            with open(self.build_commits_file, encoding="utf-8") as f:
                return json.load(f)

    def _save_build_commits(self, data: dict) -> None:
        """Save build commits to JSON file."""
        data["metadata"]["last_updated"] = datetime.now().isoformat()
        with open(self.build_commits_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)

    def get_attempt_count(self, subtask_id: str) -> int:
        """
        Get how many times this subtask has been attempted.

        Args:
            subtask_id: ID of the subtask

        Returns:
            Number of attempts
        """
        history = self._load_attempt_history()
        subtask_data = history["subtasks"].get(subtask_id, {})
        return len(subtask_data.get("attempts", []))

    def record_attempt(
        self,
        subtask_id: str,
        session: int,
        success: bool,
        approach: str,
        error: str | None = None,
    ) -> None:
        """
        Record an attempt at a subtask.

        Args:
            subtask_id: ID of the subtask
            session: Session number
            success: Whether the attempt succeeded
            approach: Description of the approach taken
            error: Error message if failed
        """
        history = self._load_attempt_history()

        # Initialize subtask entry if it doesn't exist
        if subtask_id not in history["subtasks"]:
            history["subtasks"][subtask_id] = {"attempts": [], "status": "pending"}

        # Add the attempt
        attempt = {
            "session": session,
            "timestamp": datetime.now().isoformat(),
            "approach": approach,
            "success": success,
            "error": error,
        }
        history["subtasks"][subtask_id]["attempts"].append(attempt)

        # Update status
        if success:
            history["subtasks"][subtask_id]["status"] = "completed"
        else:
            history["subtasks"][subtask_id]["status"] = "failed"

        self._save_attempt_history(history)

    def get_last_good_commit(self) -> str | None:
        """
        Find the most recent commit where build was working.

        Returns:
            Commit hash or None
        """
        commits = self._load_build_commits()
        return commits.get("last_good_commit")

    def record_good_commit(
        self, commit_hash: str, subtask_id: str, commit_before: str | None = None
    ) -> None:
        """
        Record a commit where the build was working.

        Args:
            commit_hash: Git commit hash
            subtask_id: Subtask that was successfully completed
            commit_before: HEAD when the session started. With it the review
                groups the subtask's own range, ``commit_before..commit_hash``,
                and a commit made between two sessions (QA fixer, a person)
                is not absorbed by the next subtask. Records written before
                it existed fall back to the previous record.
        """
        commits = self._load_build_commits()

        commit_record = {
            "hash": commit_hash,
            "subtask_id": subtask_id,
            "timestamp": datetime.now().isoformat(),
        }
        if commit_before:
            commit_record["commit_before"] = commit_before

        commits["commits"].append(commit_record)
        commits["last_good_commit"] = commit_hash

        self._save_build_commits(commits)

    def mark_subtask_stuck(
        self, subtask_id: str, reason: str, kind: str = "max_attempts"
    ) -> None:
        """
        Mark a subtask as needing human intervention.

        Args:
            subtask_id: ID of the subtask
            reason: Why it's stuck
            kind: Why, as the subtask panel reads it
                (``foundation.subtask_unblock.BLOCKED_KINDS``)
        """
        history = self._load_attempt_history()

        stuck_entry = {
            "subtask_id": subtask_id,
            "reason": reason,
            "escalated_at": datetime.now().isoformat(),
            "attempt_count": self.get_attempt_count(subtask_id),
        }

        # Check if already in stuck list
        existing = [
            s for s in history["stuck_subtasks"] if s["subtask_id"] == subtask_id
        ]
        if not existing:
            history["stuck_subtasks"].append(stuck_entry)

        # Update subtask status
        if subtask_id in history["subtasks"]:
            history["subtasks"][subtask_id]["status"] = "stuck"

        self._save_attempt_history(history)

        # CRITICAL: also mark the subtask as "blocked" in implementation_plan.json.
        # Recording the stuck status only in attempt_history.json left the subtask
        # at status "pending" in the plan, which froze the whole build:
        #   - count_subtasks() never counts it (progress % stays stuck), and
        #   - get_next_subtask() keeps returning the SAME pending subtask, so the
        #     coder retries it forever instead of advancing.
        # "blocked" counts as done for progress/phase purposes and is skipped by
        # get_next_subtask(), so the build moves on to the next subtask / QA while
        # the stuck entry above still flags it for human intervention.
        self._mark_subtask_blocked_in_plan(subtask_id, reason, kind)

    def _mark_subtask_blocked_in_plan(
        self, subtask_id: str, reason: str, kind: str = "max_attempts"
    ) -> None:
        """Set a subtask's status to "blocked" in implementation_plan.json.

        Best-effort: any I/O or JSON error is swallowed so recovery bookkeeping
        never crashes the build loop.
        """
        plan_file = self.spec_dir / "implementation_plan.json"
        if not plan_file.exists():
            return

        try:
            with open(plan_file, encoding="utf-8") as f:
                plan = json.load(f)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return

        updated = False
        for phase in plan.get("phases", []):
            for subtask in phase.get("subtasks", phase.get("chunks", [])):
                if subtask.get("id") == subtask_id:
                    block(subtask, reason, kind)
                    updated = True

        if not updated:
            return

        try:
            with open(plan_file, "w", encoding="utf-8") as f:
                json.dump(plan, f, indent=2)
        except OSError:
            return

    def get_stuck_subtasks(self) -> list[dict]:
        """
        Get all subtasks marked as stuck.

        Returns:
            List of stuck subtask entries
        """
        history = self._load_attempt_history()
        return history.get("stuck_subtasks", [])

    def get_subtask_history(self, subtask_id: str) -> dict:
        """
        Get the attempt history for a specific subtask.

        Args:
            subtask_id: ID of the subtask

        Returns:
            Subtask history dict with attempts
        """
        history = self._load_attempt_history()
        return history["subtasks"].get(
            subtask_id, {"attempts": [], "status": "pending"}
        )

    def get_recovery_hints(self, subtask_id: str) -> list[str]:
        """
        Get hints for recovery based on previous attempts.

        Args:
            subtask_id: ID of the subtask

        Returns:
            List of hint strings
        """
        subtask_history = self.get_subtask_history(subtask_id)
        attempts = subtask_history.get("attempts", [])

        if not attempts:
            return ["This is the first attempt at this subtask"]

        hints = [f"Previous attempts: {len(attempts)}"]

        # Add info about what was tried
        for i, attempt in enumerate(attempts[-3:], 1):
            hints.append(
                f"Attempt {i}: {attempt['approach']} - "
                f"{'SUCCESS' if attempt['success'] else 'FAILED'}"
            )
            if attempt.get("error"):
                hints.append(f"  Error: {attempt['error'][:100]}")

        # Add guidance
        if len(attempts) >= 2:
            hints.append(
                "\n⚠️  IMPORTANT: Try a DIFFERENT approach than previous attempts"
            )
            hints.append(
                "Consider: different library, different pattern, or simpler implementation"
            )

        return hints

    def reset_subtask(self, subtask_id: str) -> None:
        """
        Reset a subtask's attempt history.

        Args:
            subtask_id: ID of the subtask to reset
        """
        history = self._load_attempt_history()

        # Clear attempt history
        if subtask_id in history["subtasks"]:
            history["subtasks"][subtask_id] = {"attempts": [], "status": "pending"}

        # Remove from stuck subtasks
        history["stuck_subtasks"] = [
            s for s in history["stuck_subtasks"] if s["subtask_id"] != subtask_id
        ]

        self._save_attempt_history(history)
