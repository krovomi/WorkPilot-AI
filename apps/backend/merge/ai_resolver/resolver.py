"""
AI Resolver
===========

Core conflict resolution logic using AI.

This module provides the AIResolver class that coordinates the
resolution of conflicts using AI with minimal context.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from ..types import (
    ConflictRegion,
    MergeDecision,
    MergeResult,
    TaskSnapshot,
)
from .context import ConflictContext
from .language_utils import infer_language, locations_overlap
from .parsers import extract_code_block
from .prompts import SYSTEM_PROMPT, format_merge_prompt

logger = logging.getLogger(__name__)

# Type for the AI call function
AICallFunction = Callable[[str, str], str]


class AIResolver:
    """
    Resolves conflicts using AI with minimal context.

    This class:
    1. Builds minimal conflict context
    2. Creates focused prompts
    3. Calls AI and parses response
    4. Returns MergeResult with merged code

    Usage:
        resolver = AIResolver(ai_call_fn)
        result = resolver.resolve_conflict(conflict, baseline_code, task_snapshots)
    """

    # Maximum tokens to send to AI (keeps costs down)
    MAX_CONTEXT_TOKENS = 4000

    def __init__(
        self,
        ai_call_fn: AICallFunction | None = None,
        max_context_tokens: int = MAX_CONTEXT_TOKENS,
    ):
        """
        Initialize the AI resolver.

        Args:
            ai_call_fn: Function that calls AI. Signature: (system_prompt, user_prompt) -> response
                        If None, uses a stub that requires explicit calls.
            max_context_tokens: Maximum tokens to include in context
        """
        self.ai_call_fn = ai_call_fn
        self.max_context_tokens = max_context_tokens

    def build_context(
        self,
        conflict: ConflictRegion,
        baseline_code: str,
        task_snapshots: list[TaskSnapshot],
    ) -> ConflictContext:
        """
        Build minimal context for a conflict.

        Args:
            conflict: The conflict to resolve
            baseline_code: Original code before any changes
            task_snapshots: Snapshots from each involved task

        Returns:
            ConflictContext with minimal data for AI
        """
        # Filter to only changes at the conflict location
        task_changes: list[tuple[str, str, list]] = []

        for snapshot in task_snapshots:
            if snapshot.task_id not in conflict.tasks_involved:
                continue

            relevant_changes = [
                c
                for c in snapshot.semantic_changes
                if c.location == conflict.location
                or locations_overlap(c.location, conflict.location)
            ]

            if relevant_changes:
                task_changes.append(
                    (
                        snapshot.task_id,
                        snapshot.task_intent or "No intent specified",
                        relevant_changes,
                    )
                )

        # Determine language from file extension
        language = infer_language(conflict.file_path)

        # Build description
        change_types = [ct.value for ct in conflict.change_types]
        description = (
            f"Tasks {', '.join(conflict.tasks_involved)} made conflicting changes: "
            f"{', '.join(change_types)}. "
            f"Severity: {conflict.severity.value}. "
            f"{conflict.reason}"
        )

        return ConflictContext(
            file_path=conflict.file_path,
            location=conflict.location,
            baseline_code=baseline_code,
            task_changes=task_changes,
            conflict_description=description,
            language=language,
        )

    def resolve_conflict(
        self,
        conflict: ConflictRegion,
        baseline_code: str,
        task_snapshots: list[TaskSnapshot],
    ) -> MergeResult:
        """
        Resolve a conflict using AI.

        Args:
            conflict: The conflict to resolve
            baseline_code: Original code at the conflict location
            task_snapshots: Snapshots from involved tasks

        Returns:
            MergeResult with the resolution
        """
        if not self.ai_call_fn:
            return MergeResult(
                decision=MergeDecision.NEEDS_HUMAN_REVIEW,
                file_path=conflict.file_path,
                explanation="No AI function configured",
                conflicts_remaining=[conflict],
            )

        # Build context
        context = self.build_context(conflict, baseline_code, task_snapshots)

        # Check token limit
        if context.estimated_tokens > self.max_context_tokens:
            logger.warning(
                f"Context too large ({context.estimated_tokens} tokens), "
                "flagging for human review"
            )
            return MergeResult(
                decision=MergeDecision.NEEDS_HUMAN_REVIEW,
                file_path=conflict.file_path,
                explanation=f"Context too large for AI ({context.estimated_tokens} tokens)",
                conflicts_remaining=[conflict],
            )

        # Build prompt
        prompt_context = context.to_prompt_context()
        prompt = format_merge_prompt(prompt_context, context.language)

        # Call AI
        try:
            logger.info(f"Calling AI to resolve conflict in {conflict.file_path}")
            response = self.ai_call_fn(SYSTEM_PROMPT, prompt)

            # Parse response
            merged_code = extract_code_block(response, context.language)

            if merged_code:
                return MergeResult(
                    decision=MergeDecision.AI_MERGED,
                    file_path=conflict.file_path,
                    merged_content=merged_code,
                    conflicts_resolved=[conflict],
                    ai_calls_made=1,
                    tokens_used=context.estimated_tokens,
                    explanation=f"AI resolved conflict at {conflict.location}",
                )
            else:
                logger.warning("Could not parse AI response")
                return MergeResult(
                    decision=MergeDecision.NEEDS_HUMAN_REVIEW,
                    file_path=conflict.file_path,
                    explanation="Could not parse AI merge response",
                    conflicts_remaining=[conflict],
                    ai_calls_made=1,
                    tokens_used=context.estimated_tokens,
                )

        except Exception as e:
            logger.error(f"AI call failed: {e}")
            return MergeResult(
                decision=MergeDecision.FAILED,
                file_path=conflict.file_path,
                error=str(e),
                conflicts_remaining=[conflict],
            )
