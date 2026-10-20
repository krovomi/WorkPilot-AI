#!/usr/bin/env python3
"""
Codebase Map Management
=======================

What each file of the project is for — one note per file in the vault
(``knowledge/projects/<project>/memory/codebase/``), shared by every spec of
the project and every agent connected to the brain.
"""

from pathlib import Path

from .store import get_project_memory, remember


def update_codebase_map(spec_dir: Path, discoveries: dict[str, str]) -> None:
    """
    Record newly discovered file purposes. An existing file's note is updated.

    Args:
        spec_dir: Path to spec directory
        discoveries: Dictionary mapping file paths to their purposes
            Example: {
                "src/api/auth.py": "Handles JWT authentication",
                "src/models/user.py": "User database model"
            }
    """
    if not discoveries:
        return

    def write(memory) -> bool:
        wrote = False
        for path, purpose in discoveries.items():
            wrote |= memory.record_discovery(str(path), str(purpose))
        return wrote

    remember(spec_dir, write)


def load_codebase_map(spec_dir: Path) -> dict[str, str]:
    """
    Load the project's codebase map.

    Returns:
        Dictionary mapping file paths to their purposes (empty when none).
    """
    memory = get_project_memory(spec_dir)
    return memory.load_codebase_map() if memory else {}
