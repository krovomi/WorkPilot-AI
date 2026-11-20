"""A model's opinion on a queued pair: the prompt fences both notes, and the
answer is read into a closed shape whatever else the model wrote around it."""

from __future__ import annotations

import json

import agent_runtime
import pytest
from brain.lifecycle import advisor

PAIR = {
    "a": {"text": "Run migrations before the deploy."},
    "b": {"text": "Run migrations after the deploy."},
    "detail": "opposite order",
}


class Runtime:
    def __init__(self, answer: str = "", error: BaseException | None = None):
        self.answer, self.error = answer, error
        self.calls: list[tuple[str, dict]] = []

    async def oneshot_completion(self, prompt: str, **kwargs) -> str:
        self.calls.append((prompt, kwargs))
        if self.error:
            raise self.error
        return self.answer


@pytest.fixture
def runtime(monkeypatch):
    def use(**kwargs) -> Runtime:
        installed = Runtime(**kwargs)
        monkeypatch.setattr(agent_runtime, "_runtime", installed)
        return installed

    return use


class TestPrompt:
    def test_both_notes_are_fenced_and_the_hint_is_capped(self):
        text = advisor.build_prompt("note a", "note b", "x" * 300)

        assert "Note A:\n<user_content>\nnote a\n</user_content>" in text
        assert "Note B:\n<user_content>\nnote b\n</user_content>" in text
        assert "x" * 200 in text and "x" * 201 not in text

    def test_without_a_detail_there_is_no_hint(self):
        assert "flagged" not in advisor.build_prompt("a", "b")


class TestParse:
    def test_the_first_object_is_read_even_with_braces_after_it(self):
        answer = (
            'Sure. {"verdict": "Contradiction", "prefer": "B", '
            '"canonical": "Run them after.", "reason": "newer"} '
            "(compare {a} and {b})"
        )

        assert advisor.parse_opinion(answer) == {
            "verdict": "contradiction",
            "prefer": "b",
            "canonical": "Run them after.",
            "reason": "newer",
        }

    def test_a_brace_that_opens_no_object_is_skipped(self):
        answer = 'Note {a}: {"verdict": "duplicate"}'

        assert advisor.parse_opinion(answer)["verdict"] == "duplicate"

    @pytest.mark.parametrize(
        "answer",
        ["", None, "no json here", "{broken", '{"verdict": "maybe"}', '["x"]'],
    )
    def test_anything_else_is_no_opinion(self, answer):
        assert advisor.parse_opinion(answer) is None

    def test_an_unknown_preference_is_none_and_texts_are_capped(self):
        opinion = advisor.parse_opinion(
            json.dumps(
                {
                    "verdict": "complementary",
                    "prefer": "both",
                    "canonical": "c" * 3000,
                    "reason": "r" * 500,
                }
            )
        )

        assert opinion["prefer"] == "none"
        assert len(opinion["canonical"]) == advisor._MAX_CANONICAL
        assert opinion["canonical"].endswith("…")
        assert len(opinion["reason"]) == advisor._MAX_REASON


@pytest.mark.asyncio
class TestSuggest:
    async def test_without_a_runtime(self, monkeypatch):
        monkeypatch.setattr(agent_runtime, "_runtime", None)

        assert await advisor.suggest(PAIR) == {"ok": False, "code": "no-runtime"}

    @pytest.mark.parametrize(
        "entry",
        [
            {"a": {"text": "x"}},
            {"a": "x", "b": {"text": "y"}},
            {"a": {"text": ""}, "b": {"text": "y"}},
        ],
    )
    async def test_a_pair_without_two_texts_is_invalid(self, runtime, entry):
        installed = runtime(answer="{}")

        assert await advisor.suggest(entry) == {"ok": False, "code": "invalid"}
        assert installed.calls == []

    async def test_an_opinion_from_the_provider(self, runtime):
        installed = runtime(answer='{"verdict": "contradiction", "prefer": "a"}')

        reply = await advisor.suggest(PAIR, project_dir="/p")

        assert reply == {
            "ok": True,
            "opinion": {
                "verdict": "contradiction",
                "prefer": "a",
                "canonical": "",
                "reason": "",
            },
        }
        [(prompt, kwargs)] = installed.calls
        assert "opposite order" in prompt
        assert kwargs == {"system_prompt": advisor._SYSTEM, "project_dir": "/p"}

    async def test_a_refusing_provider(self, runtime):
        runtime(error=ValueError("offline"))

        assert await advisor.suggest(PAIR) == {"ok": False, "code": "provider-refused"}

    async def test_an_answer_without_an_opinion(self, runtime):
        runtime(answer="I cannot tell.")

        assert await advisor.suggest(PAIR) == {"ok": False, "code": "no-answer"}
