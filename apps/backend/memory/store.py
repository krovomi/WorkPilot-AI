"""The one door from the build to its memory: the vault.

Every function of this package opens the project's memory here, so there is
exactly one answer to "where does a build remember what it learned?" —
`brain.project_memory`, i.e. ``knowledge/projects/<project>/memory/`` in the
shared Obsidian vault. See that module for the layout and the rules.
"""

from __future__ import annotations

from pathlib import Path

from brain.project_memory import ProjectMemory, get_graph_hints, is_memory_enabled

__all__ = ["get_graph_hints", "get_project_memory", "is_memory_enabled", "remember"]


def get_project_memory(
    spec_dir: Path | str | None, project_dir: Path | str | None = None
) -> ProjectMemory | None:
    """The memory of *spec_dir*'s project, or ``None`` when memory is off."""
    memory = ProjectMemory(spec_dir, project_dir)
    return memory if memory.is_enabled else None


def remember(spec_dir: Path | str, write) -> bool:
    """Run ``write(memory)`` and sync once. ``False`` when memory is off or failed."""
    memory = get_project_memory(spec_dir)
    if memory is None:
        return False
    try:
        return bool(write(memory))
    finally:
        memory.flush()
