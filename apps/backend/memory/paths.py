#!/usr/bin/env python3
"""
Legacy Memory Directory
=======================

``<spec_dir>/memory/`` used to hold what builds learned. No knowledge is
written there any more — the vault is the one store (`memory.store`) — and the
old files found there are imported into the vault and set aside
(`brain.project_memory.import_legacy_spec_memory`). The directory itself still
holds the recovery state of ``services/recovery.py``. These helpers only name
the path; they no longer create it.
"""

from pathlib import Path


def get_memory_dir(spec_dir: Path) -> Path:
    """
    The legacy memory directory of a spec (not created).

    Args:
        spec_dir: Path to spec directory (e.g., .workpilot/specs/001-feature/)

    Returns:
        Path to memory directory
    """
    return Path(spec_dir) / "memory"


def get_session_insights_dir(spec_dir: Path) -> Path:
    """
    The legacy session insights directory of a spec (not created).

    Args:
        spec_dir: Path to spec directory

    Returns:
        Path to session_insights directory
    """
    return get_memory_dir(spec_dir) / "session_insights"


def clear_memory(spec_dir: Path) -> None:
    """
    Delete a spec's memory directory (recovery state and any legacy files).

    What the vault holds is not touched: it is the project's memory, shared by
    every spec and every agent, and a person edits it in Obsidian.

    Args:
        spec_dir: Path to spec directory
    """
    memory_dir = get_memory_dir(spec_dir)

    if memory_dir.exists():
        import shutil

        shutil.rmtree(memory_dir)
