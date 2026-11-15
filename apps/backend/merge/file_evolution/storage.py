"""
Storage and Persistence Module
================================

Loads and saves the evolution record (``file_evolution.json``).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from foundation.file_utils import write_json_atomic

from ..types import FileEvolution

logger = logging.getLogger(__name__)


class EvolutionStorage:
    """
    Manages persistence of file evolution data.

    Responsibilities:
    - Load/save evolution data to JSON
    - Paths relative to the project
    """

    def __init__(
        self,
        project_dir: Path,
        storage_dir: Path,
    ):
        """
        Initialize evolution storage.

        Args:
            project_dir: Root directory of the project
            storage_dir: Directory for evolution data (.workpilot/)
        """
        self.project_dir = Path(project_dir).resolve()
        self.storage_dir = Path(storage_dir).resolve()
        self.evolution_file = self.storage_dir / "file_evolution.json"

        self.storage_dir.mkdir(parents=True, exist_ok=True)

    def load_evolutions(self) -> dict[str, FileEvolution]:
        """
        Load evolution data from disk.

        Returns:
            Dictionary mapping file paths to FileEvolution objects
        """
        if not self.evolution_file.exists():
            return {}

        try:
            with open(self.evolution_file, encoding="utf-8") as f:
                data = json.load(f)

            evolutions = {}
            for file_path, evolution_data in data.items():
                evolutions[file_path] = FileEvolution.from_dict(evolution_data)

            logger.debug(f"Loaded evolution data for {len(evolutions)} files")
            return evolutions

        except Exception as e:
            logger.error(f"Failed to load evolution data: {e}")
            return {}

    def save_evolutions(self, evolutions: dict[str, FileEvolution]) -> None:
        """
        Persist evolution data to disk.

        Args:
            evolutions: Dictionary mapping file paths to FileEvolution objects
        """
        try:
            data = {
                file_path: evolution.to_dict()
                for file_path, evolution in evolutions.items()
            }

            # Written aside then moved: a save that fails halfway leaves the
            # previous file, not a truncated one that loads as nothing.
            write_json_atomic(self.evolution_file, data)

            logger.debug(f"Saved evolution data for {len(evolutions)} files")

        except Exception as e:
            logger.error(f"Failed to save evolution data: {e}")

    def get_relative_path(self, file_path: Path | str) -> str:
        """
        Get path relative to project root.

        Args:
            file_path: Absolute or relative file path

        Returns:
            Path relative to project directory
        """
        path = Path(file_path)
        if path.is_absolute():
            try:
                # Resolve both paths to handle symlinks (e.g., /var -> /private/var on macOS)
                resolved_path = path.resolve()
                return resolved_path.relative_to(self.project_dir).as_posix()
            except ValueError:
                # Path is not under project_dir, return as-is
                return path.as_posix()
        return path.as_posix()
