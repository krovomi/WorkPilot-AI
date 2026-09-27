#!/usr/bin/env python3
"""
Patterns and Gotchas Management
================================

Code patterns to follow and pitfalls to avoid, one note each in the vault
(``knowledge/projects/<project>/memory/{patterns,gotchas}/``). The same text
recorded twice is the same note.
"""

from pathlib import Path

from .store import get_project_memory, remember


def append_gotcha(spec_dir: Path, gotcha: str) -> None:
    """
    Record a gotcha (pitfall to avoid) for the project.

    Example:
        append_gotcha(spec_dir, "Database connections must be closed in workers")
    """
    if gotcha and gotcha.strip():
        remember(spec_dir, lambda memory: memory.record_gotcha(gotcha.strip()))


def load_gotchas(spec_dir: Path) -> list[str]:
    """All gotchas of the project, oldest first."""
    memory = get_project_memory(spec_dir)
    return memory.load_gotchas() if memory else []


def append_pattern(spec_dir: Path, pattern: str) -> None:
    """
    Record a code pattern to follow in the project.

    Example:
        append_pattern(spec_dir, "Use try/except with specific exceptions")
    """
    if pattern and pattern.strip():
        remember(spec_dir, lambda memory: memory.record_pattern(pattern.strip()))


def load_patterns(spec_dir: Path) -> list[str]:
    """All patterns of the project, oldest first."""
    memory = get_project_memory(spec_dir)
    return memory.load_patterns() if memory else []
