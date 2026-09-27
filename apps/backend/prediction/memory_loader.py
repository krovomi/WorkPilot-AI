"""
Memory loading utilities for bug prediction.

Gotchas and patterns come from the project's memory in the shared brain (the
one store); the attempt history is the recovery state ``services/recovery.py``
keeps in ``<spec_dir>/memory/``.
"""

import json
from pathlib import Path


class MemoryLoader:
    """Loads historical data from memory files."""

    def __init__(self, memory_dir: Path):
        """
        Initialize the memory loader.

        Args:
            memory_dir: Path to the memory directory (e.g., specs/001/memory/)
        """
        self.memory_dir = Path(memory_dir)
        self.history_file = self.memory_dir / "attempt_history.json"

    def load_gotchas(self) -> list[str]:
        """
        Gotchas the project's builds recorded, from the shared brain.

        Returns:
            List of gotcha strings
        """
        memory = self._project_memory()
        return memory.load_gotchas() if memory else []

    def load_patterns(self) -> list[str]:
        """
        Patterns the project's builds recorded, from the shared brain.

        Returns:
            List of pattern strings
        """
        memory = self._project_memory()
        return memory.load_patterns() if memory else []

    def _project_memory(self):
        try:
            from memory.store import get_project_memory

            return get_project_memory(self.memory_dir.parent)
        except Exception:  # noqa: BLE001 - a prediction never fails on memory
            return None

    def load_attempt_history(self) -> list[dict]:
        """
        Load historical subtask attempts.

        Returns:
            List of attempt dictionaries with keys like:
            - subtask_id
            - subtask_description
            - status
            - error_message
            - files_modified
        """
        if not self.history_file.exists():
            return []

        try:
            with open(self.history_file, encoding="utf-8") as f:
                history = json.load(f)
                return history.get("attempts", [])
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return []
