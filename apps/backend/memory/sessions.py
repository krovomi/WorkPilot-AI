#!/usr/bin/env python3
"""
Session Insights Management
============================

What each coding session did, one note per session in the vault
(``knowledge/projects/<project>/memory/sessions/<spec>/session-NNN.md``). Its
discoveries (files, patterns, gotchas) are filed as their own notes, where the
next spec of the project finds them.
"""

from pathlib import Path
from typing import Any

from .store import get_project_memory, remember


def save_session_insights(
    spec_dir: Path, session_num: int, insights: dict[str, Any]
) -> None:
    """
    Save insights from a completed session.

    Args:
        spec_dir: Path to spec directory
        session_num: Session number (1-indexed)
        insights: Dictionary containing session learnings with keys:
            - subtasks_completed: list[str] - Subtask IDs completed
            - discoveries: dict - New file purposes, patterns, gotchas found
                - files_understood: dict[str, str] - {path: purpose}
                - patterns_found: list[str] - Pattern descriptions
                - gotchas_encountered: list[str] - Gotcha descriptions
            - what_worked: list[str] - Successful approaches
            - what_failed: list[str] - Unsuccessful approaches
            - recommendations_for_next_session: list[str] - Suggestions
    """
    remember(spec_dir, lambda memory: memory.record_session(session_num, insights))


def load_all_insights(spec_dir: Path) -> list[dict[str, Any]]:
    """
    Load all session insights of this spec, ordered by session number.

    Returns:
        List of insight dictionaries, oldest to newest
    """
    memory = get_project_memory(spec_dir)
    return memory.load_sessions(spec_only=True) if memory else []
