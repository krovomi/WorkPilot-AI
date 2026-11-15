"""
Pattern Applicator for the Autonomous Agent Learning Loop.

Generates prompt augmentations from stored patterns and injects them
into agent system prompts before each build.

This is the one injector of the learning loop's patterns: the session memory
context (`agents.memory_manager.get_memory_context`) reads the same vault
folder but leaves these notes to it, so a pattern reaches a prompt once, behind
its confidence gate and inside ``MAX_TOKENS``.
"""

import logging

from .models import LearningPattern, PatternType
from .pattern_storage import PatternStorage

logger = logging.getLogger(__name__)


class PatternApplicator:
    """Generates prompt augmentations from stored learning patterns."""

    MAX_PATTERNS_PER_SECTION = 5
    MAX_TOTAL_PATTERNS = 10
    MIN_CONFIDENCE = 0.6
    MAX_TOKENS = 600
    CHARS_PER_TOKEN = 4

    def __init__(self, storage: PatternStorage):
        self.storage = storage

    def get_instructions_for_phase(
        self,
        phase: str,
        min_confidence: float | None = None,
        task_context: dict | None = None,
    ) -> str:
        """Generate a learning-based instruction block to append to agent prompts.

        Args:
            phase: The agent phase (planning, coding, qa_review, qa_fixing)
            min_confidence: Minimum confidence threshold (defaults to MIN_CONFIDENCE)
            task_context: Optional task context for filtering by tags

        Returns:
            Formatted markdown string to append to the agent system prompt,
            or empty string if no applicable patterns.
        """
        return self.render(self.select(phase, min_confidence, task_context))

    def select(
        self,
        phase: str,
        min_confidence: float | None = None,
        task_context: dict | None = None,
        exclude: frozenset[str] = frozenset(),
    ) -> list[LearningPattern]:
        """The patterns a prompt of ``phase`` carries, best first, and records them.

        ``exclude`` names the patterns a person turned off for one task.
        """
        threshold = min_confidence or self.MIN_CONFIDENCE
        patterns = [
            p
            for p in self.storage.get_patterns_for_phase(
                phase, min_confidence=threshold
            )
            if p.pattern_id not in exclude
        ]
        if not patterns:
            return []

        # Filter by context tags if task context is provided
        if task_context and task_context.get("tags"):
            task_tags = set(task_context["tags"])
            # Boost relevance for patterns matching task tags
            for p in patterns:
                if task_tags & set(p.context_tags):
                    p.confidence = min(0.99, p.confidence * 1.1)

        # Sort by confidence descending, then by occurrence_count
        patterns.sort(key=lambda p: (p.confidence, p.occurrence_count), reverse=True)

        # Limit each section, then the total.
        selected: list[LearningPattern] = []
        for kind in (
            PatternType.SUCCESS,
            PatternType.FAILURE,
            PatternType.OPTIMIZATION,
        ):
            selected += [p for p in patterns if p.pattern_type == kind][
                : self.MAX_PATTERNS_PER_SECTION
            ]
        selected = selected[: self.MAX_TOTAL_PATTERNS]

        # Hold the block to its token budget: whole patterns, best first, and
        # never a truncated instruction.
        budget = self.MAX_TOKENS * self.CHARS_PER_TOKEN
        kept: list[LearningPattern] = []
        used = 0
        for p in sorted(selected, key=lambda p: p.confidence, reverse=True):
            cost = len(p.actionable_instruction) + 32
            if kept and used + cost > budget:
                continue
            kept.append(p)
            used += cost

        # Track which patterns are being applied
        if kept:
            self.storage.record_application([p.pattern_id for p in kept])
        return kept

    @staticmethod
    def render(kept: list[LearningPattern]) -> str:
        """The instruction block for the patterns ``select`` kept, or ""."""
        if not kept:
            return ""
        total_builds = max(len(set(bid for p in kept for bid in p.source_build_ids)), 1)
        lines = [
            f"\n## Learning Insights (auto-generated from {total_builds} previous builds)\n"
        ]
        sections = (
            (PatternType.SUCCESS, "### Success Patterns (apply these):"),
            (PatternType.FAILURE, "### Failure Patterns (avoid these):"),
            (PatternType.OPTIMIZATION, "### Optimization Tips:"),
        )
        for kind, heading in sections:
            group = [p for p in kept if p.pattern_type == kind]
            if not group:
                continue
            lines.append(heading)
            for i, p in enumerate(group, 1):
                lines.append(
                    f"{i}. [confidence: {p.confidence:.2f}] {p.actionable_instruction}"
                )
            lines.append("")
        return "\n".join(lines)

    def get_applied_pattern_ids(self, phase: str) -> list[str]:
        """Get pattern IDs that would be applied for the given phase."""
        patterns = self.storage.get_patterns_for_phase(
            phase, min_confidence=self.MIN_CONFIDENCE
        )
        patterns.sort(key=lambda p: p.confidence, reverse=True)
        return [p.pattern_id for p in patterns[: self.MAX_TOTAL_PATTERNS]]

    def record_outcome(self, pattern_ids: list[str], success: bool) -> None:
        """Record the outcome of a build where patterns were applied."""
        self.storage.record_outcome(pattern_ids, success)
