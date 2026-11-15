"""The one-shot Claude session the insight extractor runs (`ClaudeSDKRuntime`).

The SDK client is a stand-in that replays real SDK messages: what the session
returns is the text the model wrote, its thinking marked as such, the tool
calls counted, and the usage of the last message that carried one. An error
reaches the caller as the exception's class name only, never its text.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from claude_agent_sdk import (
    AssistantMessage,
    ResultMessage,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
)
from core.runtime import SessionStatus
from core.runtimes import claude_sdk_runtime
from core.runtimes.claude_sdk_runtime import ClaudeSDKRuntime


class Config:
    is_claude_sdk = True
    provider = "claude"
    model = "claude-test-model"


class FakeClient:
    """What `create_simple_client` returns, answering with `messages`."""

    def __init__(self, messages: list, fail_on: str | None = None) -> None:
        self.messages = messages
        self.fail_on = fail_on
        self.prompts: list[str] = []
        self.entered = 0

    async def __aenter__(self):
        self.entered += 1
        return self

    async def __aexit__(self, *exc):
        return False

    async def query(self, prompt: str) -> None:
        if self.fail_on == "query":
            raise ConnectionError("api.example.test refused req_0123 at /home/dana")
        self.prompts.append(prompt)

    async def receive_response(self):
        for message in self.messages:
            yield message


@pytest.fixture
def built(monkeypatch):
    seen: dict = {}

    def install(client):
        def factory(**kwargs):
            seen.update(kwargs)
            if isinstance(client, Exception):
                raise client
            return client

        monkeypatch.setattr(claude_sdk_runtime, "create_simple_client", factory)
        return seen

    return install


def runtime(project_dir=None) -> ClaudeSDKRuntime:
    return ClaudeSDKRuntime(
        spec_dir=None,
        phase="insight_extraction",
        project_dir=project_dir,
        agent_type="insight_extractor",
        config=Config(),
        cli_thinking=2048,
    )


def test_the_session_is_built_for_the_agent_and_its_project(built, tmp_path):
    seen = built(FakeClient([]))

    runtime(str(tmp_path))

    assert seen == {
        "agent_type": "insight_extractor",
        "model": "claude-test-model",
        "max_thinking_tokens": 2048,
        "cwd": Path(tmp_path),
        "max_turns": 10,
    }


def test_the_answer_is_the_text_and_thinking_the_model_wrote(built):
    client = FakeClient(
        [
            AssistantMessage(
                content=[
                    ThinkingBlock(thinking="the diff adds a widget", signature="s"),
                    ToolUseBlock(id="t1", name="Read", input={"file_path": "a.py"}),
                    TextBlock(text='  {"insights": ["widgets"]}  '),
                ],
                model="claude-test-model",
                usage={"input_tokens": 5},
            ),
            ResultMessage(
                subtype="success",
                duration_ms=1,
                duration_api_ms=1,
                is_error=False,
                num_turns=1,
                session_id="s1",
                usage={"input_tokens": 12, "output_tokens": 30},
            ),
        ]
    )
    built(client)

    result = asyncio.run(runtime().run_session("extract the insights"))

    assert result.status is SessionStatus.COMPLETED
    assert result.output == (
        '[Thinking] the diff adds a widget\n  {"insights": ["widgets"]}'
    )
    assert result.usage == {"input_tokens": 12, "output_tokens": 30}
    assert client.prompts == ["extract the insights"]
    assert client.entered == 1


def test_a_session_that_says_nothing_has_no_output(built):
    built(FakeClient([]))

    result = asyncio.run(runtime().run_session("extract"))

    assert result.status is SessionStatus.COMPLETED
    assert result.output is None
    assert result.usage == {}


def test_a_failure_is_named_by_its_class_only(built):
    built(FakeClient([], fail_on="query"))

    result = asyncio.run(runtime().run_session("extract"))

    assert result.status is SessionStatus.ERROR
    assert result.error == "ConnectionError"
    assert result.output is None


def test_a_client_that_could_not_be_built_says_so(built):
    built(ValueError("agent type refused"))

    session = runtime()
    result = asyncio.run(session.run_session("extract"))

    assert session.client is None
    assert result.status is SessionStatus.ERROR
    assert result.error == "Claude SDK client not initialized"


def test_the_runtime_is_its_own_context(built):
    built(FakeClient([]))
    session = runtime()

    async def use() -> object:
        async with session as entered:
            return entered

    assert asyncio.run(use()) is session
