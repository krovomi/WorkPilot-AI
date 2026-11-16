"""
Conflict Detector
=================

Detects conflicts between multiple task changes using rule-based analysis.

This module determines:
1. Which changes from different tasks overlap
2. Whether overlapping changes are compatible
3. What merge strategy can be used for compatible changes
4. Which conflicts need AI or human intervention

The goal is to resolve as many conflicts as possible without AI,
using deterministic rules based on semantic change types.

This is the main entry point that coordinates the conflict detection system.
The actual logic is organized into specialized modules:
- compatibility_rules: Rule definitions and indexing
- conflict_analysis: Core conflict detection algorithms
"""

from __future__ import annotations

import logging

from .compatibility_rules import build_default_rules, index_rules
from .conflict_analysis import (
    detect_conflicts,
)
from .types import (
    ConflictRegion,
    FileAnalysis,
)

# Import debug utilities
try:
    from foundation.debug import debug, debug_success
except ImportError:

    def debug(*args, **kwargs):
        pass

    def debug_success(*args, **kwargs):
        pass


logger = logging.getLogger(__name__)
MODULE = "merge.conflict_detector"


class ConflictDetector:
    """
    Detects and classifies conflicts between task changes.

    Uses a comprehensive rule base to determine compatibility
    between different semantic change types, enabling maximum
    auto-merge capability.

    Example:
        detector = ConflictDetector()
        conflicts = detector.detect_conflicts({
            "task-001": analysis1,
            "task-002": analysis2,
        })
        for conflict in conflicts:
            if conflict.can_auto_merge:
                print(f"Can auto-merge with {conflict.merge_strategy}")
            else:
                print(f"Needs {conflict.severity} review")
    """

    def __init__(self):
        """Initialize with default compatibility rules."""
        debug(MODULE, "Initializing ConflictDetector")
        self._rules = build_default_rules()
        self._rule_index = index_rules(self._rules)
        debug_success(
            MODULE, "ConflictDetector initialized", rule_count=len(self._rules)
        )

    def detect_conflicts(
        self,
        task_analyses: dict[str, FileAnalysis],
    ) -> list[ConflictRegion]:
        """
        Detect conflicts between multiple task changes to the same file.

        Args:
            task_analyses: Map of task_id -> FileAnalysis

        Returns:
            List of detected conflict regions
        """
        conflicts = detect_conflicts(task_analyses, self._rule_index)

        # Summary logging
        auto_mergeable = sum(1 for c in conflicts if c.can_auto_merge)
        from .types import ConflictSeverity

        critical = sum(1 for c in conflicts if c.severity == ConflictSeverity.CRITICAL)
        debug_success(
            MODULE,
            "Conflict detection complete",
            total_conflicts=len(conflicts),
            auto_mergeable=auto_mergeable,
            critical=critical,
        )

        return conflicts
