"""What the QA agent tests share: a scripted client, a spec, the replay store.

The client is a real `AgentClient` subclass that plays a fixed list of
messages, as any provider's client does after normalisation; nothing else is
replaced. The replay recorder writes into the test's own folder.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from core.agent_client import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from replay import recorder as replay_recorder


class ScriptedClient(AgentClient):
    """Plays `messages`, then ends; `fail` is raised mid-stream when given."""

    def __init__(
        self,
        messages: list[AgentMessage] | None = None,
        *,
        fail: BaseException | None = None,
        result_error: str | None = None,
        on_stream=None,
    ) -> None:
        self.messages = messages or []
        self.fail = fail
        self.model = "gpt-5"
        self.prompts: list[str] = []
        self.on_stream = on_stream
        self.last_usage = {"input_tokens": 1000, "output_tokens": 200, "cost_usd": 0.01}
        # What ClaudeAgentClient keeps of the SDK's final ResultMessage.
        self.last_result_msg = (
            SimpleNamespace(is_error=True, result=result_error, subtype="error")
            if result_error is not None
            else SimpleNamespace(is_error=False, result="done", subtype="success")
        )

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)

    async def receive_response(self):
        if self.on_stream is not None:
            self.on_stream()
        for message in self.messages:
            yield message
        if self.fail is not None:
            raise self.fail

    def supports_subagents(self) -> bool:
        return False

    def provider_name(self) -> str:
        return "openai"

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        return None


def say(text: str) -> AgentMessage:
    return AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
    )


def tool(name: str, **tool_input) -> AgentMessage:
    return AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[
            ContentBlock(
                type=ContentBlockType.TOOL_USE, tool_name=name, tool_input=tool_input
            )
        ],
    )


def result(content: str, *, error: bool = False) -> AgentMessage:
    return AgentMessage(
        role=MessageRole.USER,
        content=[
            ContentBlock(
                type=ContentBlockType.TOOL_RESULT,
                result_content=content,
                is_error=error,
            )
        ],
    )


@pytest.fixture
def qa_kit():
    """The client class and the message builders, for the QA agent tests."""
    return SimpleNamespace(Client=ScriptedClient, say=say, tool=tool, result=result)


@pytest.fixture
def replays(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The Session History store, in the test's own folder."""
    store = tmp_path / "replays"
    monkeypatch.setattr(
        replay_recorder,
        "_replay_recorder",
        replay_recorder.ReplayRecorder(storage_dir=store),
    )
    return store


def saved_replays(store: Path) -> list[dict]:
    return [
        json.loads(p.read_text(encoding="utf-8")) for p in sorted(store.glob("*.json"))
    ]


@pytest.fixture
def read_replays():
    return saved_replays


@pytest.fixture
def qa_spec(tmp_path: Path) -> Path:
    """A task's spec folder inside a project, with a plan the reviewer edits."""
    spec = tmp_path / "project" / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Login\n\nA login form.\n", encoding="utf-8")
    (spec / "implementation_plan.json").write_text(
        json.dumps({"feature": "login", "phases": []}), encoding="utf-8"
    )
    return spec
