"""
Merge Preview System
====================

What merging a task would meet, before the merge itself runs.

The merge is ``core.workspace``: git, then the user's provider for each file
both sides changed. This package reads what each task changed and where two
tasks' changes collide, for the preview the user sees first.

Components:
- SemanticAnalyzer: regex-based semantic change extraction
- ConflictDetector: rule-based conflict detection and compatibility
- FileEvolutionTracker: what each task changed, read from git
- MergePreview: the preview ``core.workspace`` shows before merging

Usage:
    from merge import MergePreview

    preview = MergePreview(project_dir)
    preview.evolution_tracker.refresh_from_git(task_id, worktree_path)
    report = preview.preview_merge([task_id])
"""

from .compatibility_rules import CompatibilityRule
from .conflict_detector import ConflictDetector
from .file_evolution import FileEvolutionTracker
from .preview import MergePreview
from .semantic_analyzer import SemanticAnalyzer
from .types import (
    ChangeType,
    ConflictRegion,
    ConflictSeverity,
    FileAnalysis,
    FileEvolution,
    MergeStrategy,
    SemanticChange,
    TaskSnapshot,
)

__all__ = [
    "ChangeType",
    "SemanticChange",
    "FileAnalysis",
    "ConflictRegion",
    "ConflictSeverity",
    "MergeStrategy",
    "TaskSnapshot",
    "FileEvolution",
    "CompatibilityRule",
    "SemanticAnalyzer",
    "ConflictDetector",
    "FileEvolutionTracker",
    "MergePreview",
]
