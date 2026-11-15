"""The AI resolver: what it asks the model, and what it accepts back.

A region the model sends back is written into the project file. So only code
the model put in a fenced block counts as an answer, and only the code: a
sentence, or the block's language tag, must never land in the file.
"""

from __future__ import annotations

import asyncio
from datetime import datetime

import agent_runtime
import pytest
from merge.ai_resolver import AIResolver, create_ai_resolver
from merge.ai_resolver.language_utils import infer_language, locations_overlap
from merge.ai_resolver.parsers import extract_code_block
from merge.types import (
    ChangeType,
    ConflictRegion,
    ConflictSeverity,
    MergeDecision,
    SemanticChange,
    TaskSnapshot,
)


def region(file_path="src/Service.cs", location="function:Save", tasks=("t1", "t2")):
    return ConflictRegion(
        file_path=file_path,
        location=location,
        tasks_involved=list(tasks),
        change_types=[ChangeType.MODIFY_FUNCTION, ChangeType.MODIFY_FUNCTION],
        severity=ConflictSeverity.HIGH,
        can_auto_merge=False,
        reason="both tasks rewrote the body",
    )


def edit(location, after, target="Save"):
    return SemanticChange(
        change_type=ChangeType.MODIFY_FUNCTION,
        target=target,
        location=location,
        line_start=1,
        line_end=3,
        content_after=after,
    )


def task(task_id, *changes, intent=None):
    return TaskSnapshot(
        task_id=task_id,
        task_intent=intent,
        started_at=datetime(2026, 11, 15, 9, 0, 0),
        semantic_changes=list(changes),
    )


class Model:
    """Answers with a fixed text and keeps the prompts it was given."""

    def __init__(self, answer="", error=None):
        self.answer = answer
        self.error = error
        self.prompts: list[tuple[str, str]] = []

    def __call__(self, system, user):
        self.prompts.append((system, user))
        if self.error:
            raise self.error
        return self.answer


class TestWhatTheModelSendsBack:
    @pytest.mark.parametrize(
        "answer",
        [
            "```csharp\npublic void Save() { Log(); Write(); }\n```",
            "```c#\npublic void Save() { Log(); Write(); }\n```",
            "Here it is:\n```\npublic void Save() { Log(); Write(); }\n```\nDone.",
        ],
    )
    def test_only_the_code_of_a_fenced_block_is_kept(self, answer):
        assert extract_code_block(answer, "csharp") == (
            "public void Save() { Log(); Write(); }"
        )

    def test_a_block_in_another_language_than_the_file_keeps_no_tag(self):
        answer = "```typescript\nconst a = useAuth();\n```"
        assert extract_code_block(answer, "tsx") == "const a = useAuth();"

    def test_the_block_in_the_file_language_wins_over_an_earlier_one(self):
        answer = "Before:\n```text\nold\n```\nMerged:\n```python\ndef f():\n    return 1\n```"
        assert extract_code_block(answer, "python") == "def f():\n    return 1"

    @pytest.mark.parametrize(
        ("answer", "language"),
        [
            ("I cannot merge these changes (they contradict each other).", "text"),
            ("I would import both modules, then call them in order.", "python"),
            ("", "python"),
        ],
    )
    def test_prose_is_not_an_answer(self, answer, language):
        assert extract_code_block(answer, language) is None

    def test_an_unclosed_block_is_not_an_answer(self):
        assert extract_code_block("```python\ndef f():\n", "python") is None


class TestTheFileLanguage:
    @pytest.mark.parametrize(
        ("path", "language"),
        [
            ("src/Service.cs", "csharp"),
            ("src/Service.CS", "csharp"),
            ("lib/Module.fs", "fsharp"),
            ("native/core.cpp", "cpp"),
            ("native/core.h", "c"),
            ("app/main.dart", "dart"),
            ("web/App.vue", "vue"),
            ("db/schema.sql", "sql"),
            ("scripts/run.sh", "bash"),
            ("scripts/run.ps1", "powershell"),
            ("Pages/Index.razor", "razor"),
            ("web/index.mjs", "javascript"),
            ("src/App.tsx", "tsx"),
            ("src/api.ts", "typescript"),
            ("app.py", "python"),
            ("notes.unknownext", "text"),
            ("Makefile", "text"),
        ],
    )
    def test_the_extension_names_it(self, path, language):
        assert infer_language(path) == language


class TestWhichChangesBelongToTheConflict:
    def test_a_function_whose_name_starts_like_another_is_not_it(self):
        assert locations_overlap("function:get", "function:getUser") is False
        assert locations_overlap("function:getUser", "function:get") is False

    def test_the_same_location_and_a_member_of_it_are(self):
        assert locations_overlap("function:Save", "function:Save") is True
        assert locations_overlap("class:Repo", "class:Repo.save") is True
        assert locations_overlap("class:Repo.save", "class:Repo") is True

    def test_only_the_changes_at_the_conflict_reach_the_prompt(self):
        model = Model("```csharp\nvoid Save() {}\n```")
        resolver = AIResolver(ai_call_fn=model)
        snapshots = [
            task("t1", edit("function:Save", "void Save() { Log(); }")),
            task(
                "t2",
                edit("function:SaveAll", "void SaveAll() { Batch(); }", "SaveAll"),
                edit("function:Save", "void Save() { Write(); }"),
            ),
            task("t3", edit("function:Save", "void Save() { Other(); }")),
        ]

        resolver.resolve_conflict(region(), "void Save() {}", snapshots)

        prompt = model.prompts[0][1]
        assert "Log();" in prompt and "Write();" in prompt
        assert "Batch();" not in prompt
        assert "Other();" not in prompt
        assert "Language: csharp" in prompt
        assert "```csharp" in prompt
        assert "No intent specified" in prompt
        assert "both tasks rewrote the body" in prompt


class TestResolvingAConflict:
    def test_a_fenced_answer_is_an_ai_merge_of_that_code(self):
        resolver = AIResolver(
            ai_call_fn=Model("```csharp\nvoid Save() { A(); B(); }\n```")
        )
        result = resolver.resolve_conflict(
            region(), "void Save() {}", [task("t1", edit("function:Save", "A();"))]
        )

        assert result.decision == MergeDecision.AI_MERGED
        assert result.merged_content == "void Save() { A(); B(); }"
        assert result.ai_calls_made == 1
        assert result.tokens_used > 0
        assert len(result.conflicts_resolved) == 1

    @pytest.mark.parametrize(
        "answer", ["", "Sorry, these changes cannot be merged (conflict)."]
    )
    def test_an_answer_without_code_goes_to_review(self, answer):
        resolver = AIResolver(ai_call_fn=Model(answer))
        result = resolver.resolve_conflict(region(), "void Save() {}", [])

        assert result.decision == MergeDecision.NEEDS_HUMAN_REVIEW
        assert result.merged_content is None
        assert result.explanation == "Could not parse AI merge response"
        assert result.ai_calls_made == 1

    def test_a_context_over_the_budget_is_not_sent(self):
        model = Model("```csharp\nx\n```")
        resolver = AIResolver(ai_call_fn=model, max_context_tokens=10)
        result = resolver.resolve_conflict(region(), "void Save() {}\n" * 20, [])

        assert model.prompts == []
        assert result.decision == MergeDecision.NEEDS_HUMAN_REVIEW
        assert result.explanation.startswith("Context too large for AI (")

    def test_a_failing_model_fails_the_conflict(self):
        resolver = AIResolver(ai_call_fn=Model(error=RuntimeError("provider down")))
        result = resolver.resolve_conflict(region(), "void Save() {}", [])

        assert result.decision == MergeDecision.FAILED
        assert result.error == "provider down"
        assert len(result.conflicts_remaining) == 1

    def test_without_a_model_it_goes_to_review(self):
        result = AIResolver().resolve_conflict(region(), "void Save() {}", [])
        assert result.decision == MergeDecision.NEEDS_HUMAN_REVIEW
        assert result.explanation == "No AI function configured"


class _Runtime:
    def __init__(self, answer="```python\nx = 1\n```"):
        self.answer = answer
        self.calls: list[dict] = []

    async def oneshot_completion(self, prompt, **kwargs):
        self.calls.append({"prompt": prompt, **kwargs})
        await asyncio.sleep(0)
        return self.answer


class TestTheResolverAsksTheUsersProvider:
    def test_the_question_goes_through_the_one_shot_completion(
        self, monkeypatch, tmp_path
    ):
        runtime = _Runtime()
        monkeypatch.setattr(agent_runtime, "_runtime", runtime)

        resolver = create_ai_resolver(tmp_path)
        answer = resolver.ai_call_fn("SYSTEM", "USER")

        assert answer == "```python\nx = 1\n```"
        assert runtime.calls == [
            {"prompt": "USER", "system_prompt": "SYSTEM", "project_dir": str(tmp_path)}
        ]

    def test_it_needs_no_claude_token(self, monkeypatch, tmp_path):
        class _NoToken(_Runtime):
            def get_auth_token(self):
                return None

        monkeypatch.setattr(agent_runtime, "_runtime", _NoToken())
        assert create_ai_resolver(tmp_path).ai_call_fn is not None

    def test_without_a_runtime_there_is_no_model(self, monkeypatch, tmp_path):
        monkeypatch.setattr(agent_runtime, "_runtime", None)
        assert create_ai_resolver(tmp_path).ai_call_fn is None

    def test_a_provider_that_raises_gives_an_empty_answer(self, monkeypatch, tmp_path):
        class _Broken(_Runtime):
            async def oneshot_completion(self, prompt, **kwargs):
                raise RuntimeError("boom")

        monkeypatch.setattr(agent_runtime, "_runtime", _Broken())
        resolver = create_ai_resolver(tmp_path)

        assert resolver.ai_call_fn("SYSTEM", "USER") == ""
        result = resolver.resolve_conflict(region("app.py", "function:f"), "", [])
        assert result.decision == MergeDecision.NEEDS_HUMAN_REVIEW
