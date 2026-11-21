"""The Claude subscription's corrections, answered in the edits' schema."""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace

import pytest
from design_to_code.budget import Usage
from services import design_to_code_edit_calls as calls

EDITS = {"edits": [{"path": "index.html", "find": "a", "replace": "b"}], "notes": []}


class _Client:
    """The SDK client: text, then the closing result with its structured output."""

    def __init__(self, structured) -> None:
        self.structured = structured
        self.sent: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt):
        async for message in prompt:
            self.sent.append(message)

    async def receive_response(self):
        yield SimpleNamespace(content=[SimpleNamespace(text="thinking "), object()])
        yield SimpleNamespace(content=None)
        yield SimpleNamespace(
            total_cost_usd=0.0,
            structured_output=self.structured,
            usage={"input_tokens": 9, "output_tokens": 1},
        )


def _ask(monkeypatch, tmp_path, structured):
    made: dict = {}

    def factory(**kwargs):
        made.update(kwargs)
        made["client"] = _Client(structured)
        return made["client"]

    monkeypatch.setattr("core.simple_client.create_simple_client", factory)
    answer = asyncio.run(
        calls.ask_claude_for_edits(
            "claude-x", "prompt", b"\x89PNG", project_path=tmp_path
        )
    )
    return answer, made


def test_the_answer_is_the_structured_output_in_the_schema(
    monkeypatch, tmp_path
) -> None:
    answer, made = _ask(monkeypatch, tmp_path, EDITS)
    assert (json.loads(answer.text), answer.structured) == (EDITS, True)
    assert answer.usage == Usage(9, 1)
    assert made["output_format"] == {
        "type": "json_schema",
        "schema": calls.EDITS_SCHEMA,
    }
    assert made["agent_type"] == "commit_message" and made["model"] == "claude-x"
    assert made["max_turns"] == 2 and made["cwd"] == tmp_path
    content = made["client"].sent[0]["message"]["content"]
    assert content[0]["source"] == {
        "type": "base64",
        "media_type": "image/png",
        "data": "iVBORw==",
    }
    assert content[1] == {"type": "text", "text": "prompt"}


@pytest.mark.parametrize("structured", [None, ["not", "an", "object"]])
def test_without_a_structured_output_the_text_is_the_answer(
    monkeypatch, tmp_path, structured
) -> None:
    answer, _ = _ask(monkeypatch, tmp_path, structured)
    assert (answer.text, answer.structured) == ("thinking", False)
