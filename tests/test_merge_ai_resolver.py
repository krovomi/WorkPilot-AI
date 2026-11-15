#!/usr/bin/env python3
"""
Tests for AIResolver
====================

Tests AI-based conflict resolution with token optimization.

Covers:
- Resolver with and without AI function
- Context building for AI prompts
- Conflict resolution attempts
"""

from datetime import datetime

import pytest
from merge import (
    ChangeType,
    ConflictRegion,
    ConflictSeverity,
    MergeDecision,
    MergeStrategy,
    SemanticChange,
    TaskSnapshot,
)


class TestAIResolverBasics:
    """Basic AIResolver functionality."""

    def test_no_ai_function_returns_review(self, ai_resolver):
        """Without AI function, resolver returns needs-review."""
        conflict = ConflictRegion(
            file_path="test.py",
            location="function:main",
            tasks_involved=["task-001", "task-002"],
            change_types=[ChangeType.MODIFY_FUNCTION, ChangeType.MODIFY_FUNCTION],
            severity=ConflictSeverity.HIGH,
            can_auto_merge=False,
            merge_strategy=MergeStrategy.AI_REQUIRED,
        )

        result = ai_resolver.resolve_conflict(conflict, "def main(): pass", [])

        assert result.decision == MergeDecision.NEEDS_HUMAN_REVIEW
        assert "No AI function" in result.explanation

    def test_with_mock_ai_function(self, mock_ai_resolver):
        """With AI function, resolver attempts resolution."""
        snapshot = TaskSnapshot(
            task_id="task-001",
            task_intent="Add auth",
            started_at=datetime.now(),
            semantic_changes=[
                SemanticChange(
                    change_type=ChangeType.ADD_HOOK_CALL,
                    target="useAuth",
                    location="function:App",
                    line_start=5,
                    line_end=5,
                    content_after="const auth = useAuth();",
                ),
            ],
        )

        conflict = ConflictRegion(
            file_path="App.tsx",
            location="function:App",
            tasks_involved=["task-001"],
            change_types=[ChangeType.ADD_HOOK_CALL],
            severity=ConflictSeverity.MEDIUM,
            can_auto_merge=False,
            merge_strategy=MergeStrategy.AI_REQUIRED,
        )

        result = mock_ai_resolver.resolve_conflict(
            conflict, "function App() { return <div/>; }", [snapshot]
        )

        assert result.ai_calls_made == 1
        assert result.decision == MergeDecision.AI_MERGED


class TestContextBuilding:
    """Tests for AI context building."""

    def test_build_context(self, ai_resolver):
        """Context building creates minimal token representation."""
        snapshot = TaskSnapshot(
            task_id="task-001",
            task_intent="Add authentication hook",
            started_at=datetime.now(),
            semantic_changes=[
                SemanticChange(
                    change_type=ChangeType.ADD_HOOK_CALL,
                    target="useAuth",
                    location="function:App",
                    line_start=5,
                    line_end=5,
                    content_after="const auth = useAuth();",
                ),
            ],
        )

        conflict = ConflictRegion(
            file_path="App.tsx",
            location="function:App",
            tasks_involved=["task-001"],
            change_types=[ChangeType.ADD_HOOK_CALL],
            severity=ConflictSeverity.MEDIUM,
            can_auto_merge=False,
        )

        context = ai_resolver.build_context(conflict, "function App() {}", [snapshot])

        prompt = context.to_prompt_context()
        assert "function:App" in prompt
        assert "task-001" in prompt
        assert "Add authentication hook" in prompt


class TestAIMergeRetryMechanism:
    """Tests for AI merge retry mechanism with fallback (ACS-194)."""

    def test_ai_merge_system_prompt_enhanced(self):
        """AI merge system prompt is enhanced for better success rate (ACS-194)."""
        # Import from workspace package (standard import)
        from core.workspace import AI_MERGE_SYSTEM_PROMPT

        # Verify the system prompt includes enhanced guidance
        assert "expert code merge assistant" in AI_MERGE_SYSTEM_PROMPT
        assert "3-way merges" in AI_MERGE_SYSTEM_PROMPT
        # Note: The prompt focuses on "intelligently" and "task's intent" not "semantic understanding"
        assert "intelligently" in AI_MERGE_SYSTEM_PROMPT.lower()
        assert (
            "task's intent" in AI_MERGE_SYSTEM_PROMPT
            or "task intent" in AI_MERGE_SYSTEM_PROMPT
        )
        assert "best-effort" in AI_MERGE_SYSTEM_PROMPT
        # Verify key merge strategies are documented
        assert "Preserve all functional changes" in AI_MERGE_SYSTEM_PROMPT
        assert "Combine independent changes" in AI_MERGE_SYSTEM_PROMPT
        assert "Resolve overlapping changes" in AI_MERGE_SYSTEM_PROMPT

    def test_build_merge_prompt_includes_task_context(self):
        """Merge prompt builder includes task context (ACS-194)."""
        # Import from workspace package (standard import)
        from core.workspace import _build_merge_prompt

        # Test that prompt includes task name
        prompt = _build_merge_prompt(
            "test.py",
            "base content",
            "main content",
            "worktree content",
            "my-task-spec",
        )

        assert "my-task-spec" in prompt
        assert "OURS" in prompt
        assert "THEIRS" in prompt
        assert "BASE" in prompt or "common ancestor" in prompt
