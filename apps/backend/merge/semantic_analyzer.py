"""
What a task changed in a file, as changes two tasks can collide on.

The imports it added or removed and the functions it added, removed or
rewrote, read from the two versions of the file by
:func:`semantic_analysis.regex_analyzer.analyze_with_regex`.
"""

from __future__ import annotations

from pathlib import Path

from foundation.debug import debug, debug_success

from .semantic_analysis.regex_analyzer import analyze_with_regex
from .types import FileAnalysis

MODULE = "merge.semantic_analyzer"


class SemanticAnalyzer:
    """Reads the semantic changes between two versions of a file."""

    def analyze_diff(
        self,
        file_path: str,
        before: str,
        after: str,
        task_id: str | None = None,
    ) -> FileAnalysis:
        """The changes from ``before`` to ``after``; ``task_id`` only labels the log."""
        ext = Path(file_path).suffix.lower()
        debug(MODULE, f"Analyzing diff for {file_path}", extension=ext, task_id=task_id)
        analysis = analyze_with_regex(file_path, before, after, ext)
        debug_success(
            MODULE,
            f"Analysis complete for {file_path}",
            changes_found=len(analysis.changes),
            total_lines_changed=analysis.total_lines_changed,
        )
        return analysis


__all__ = ["SemanticAnalyzer"]
