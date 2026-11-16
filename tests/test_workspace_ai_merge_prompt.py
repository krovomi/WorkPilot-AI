"""The system prompt and the prompt of the AI merge in ``core.workspace``."""


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
