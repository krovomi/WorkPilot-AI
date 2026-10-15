"""Every WorkPilot-run loop stops a model that repeats itself.

The five loops (OpenAI and the compatible providers, Copilot, Ollama, Windsurf
REST and gRPC) stopped on a natural end and at ``max_turns``. A model that
called the same tool with the same arguments and got the same answer went on
until ``max_turns``, each turn re-sending the whole conversation. Now it is
told once, then stopped (``harness.domain.progress``).
"""

from __future__ import annotations

import json
from json import dumps as _dumps  # `json` is the post() keyword below
from unittest.mock import AsyncMock

import pytest
from core.agent_client import (
    ContentBlockType,
    CopilotAgentClient,
    LocalAgentClient,
    MessageRole,
    OpenAIAgentClient,
    WindsurfAgentClient,
)
from harness.domain.progress import (
    NO_PROGRESS_STOP,
    PROGRESS_NUDGE,
    REPEATS_BEFORE_NUDGE,
    REPEATS_BEFORE_STOP,
)

READ_CALL = {
    "id": "call_1",
    "function": {"name": "read_file", "arguments": json.dumps({"path": "a.py"})},
}


class _Executor:
    def __init__(self, results=None):
        self.calls = 0
        self._results = results

    async def execute(self, name, args):
        self.calls += 1
        return self._results(self.calls) if self._results else "x = 1\n"


class _Response:
    def __init__(self, data):
        self.status = 200
        self._data = data

    async def json(self):
        return self._data

    async def text(self):
        return json.dumps(self._data)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _ChatSession:
    """Answers every chat-completions POST with the same tool call."""

    def __init__(self):
        self.payloads: list[dict] = []

    def post(self, url, json=None, **kwargs):  # noqa: A002 - aiohttp's name
        # A copy: the loop keeps appending to the list it sent.
        self.payloads.append({"messages": [dict(m) for m in json["messages"]]})
        return _Response(
            {
                "choices": [
                    {
                        "message": {"content": "", "tool_calls": [READ_CALL]},
                        "finish_reason": "tool_calls",
                    }
                ]
            }
        )


def _stopped(messages) -> bool:
    return any(
        msg.role == MessageRole.SYSTEM
        and any(block.text == NO_PROGRESS_STOP for block in msg.content)
        for msg in messages
    )


def _nudged_at(payloads) -> list[int]:
    return [
        index
        for index, payload in enumerate(payloads)
        if any(m.get("content") == PROGRESS_NUDGE for m in payload["messages"])
    ]


async def _collect(client):
    await client.query("fix it")
    return [msg async for msg in client.receive_response()]


def _openai():
    client = OpenAIAgentClient(api_key="sk-test-0000", max_turns=50)
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    return client


def _copilot():
    client = CopilotAgentClient(github_token="ghp_test", max_turns=50)
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    client._get_copilot_token = AsyncMock(return_value="copilot-token")
    return client


def _windsurf_rest():
    client = WindsurfAgentClient(model="gpt-4o", max_turns=50)
    client._use_local_grpc = False
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    return client


@pytest.mark.asyncio
@pytest.mark.parametrize("make", [_openai, _copilot, _windsurf_rest])
async def test_chat_completion_loops_nudge_then_stop(make):
    client = make()
    session = _ChatSession()
    client._http_client = session
    if isinstance(client, CopilotAgentClient):
        client._get_http_client = lambda: session
    client._tool_executor = _Executor()

    messages = await _collect(client)

    assert _stopped(messages)
    assert len(session.payloads) == REPEATS_BEFORE_STOP  # not max_turns
    # The nudge went out once, on the request after the third identical turn.
    assert _nudged_at(session.payloads)[0] == REPEATS_BEFORE_NUDGE
    nudges = sum(
        1
        for m in session.payloads[-1]["messages"]
        if m.get("content") == PROGRESS_NUDGE
    )
    assert nudges == 1


@pytest.mark.asyncio
async def test_a_call_whose_result_changes_is_progress():
    client = _openai()
    client.max_turns = 8
    session = _ChatSession()
    client._http_client = session
    client._tool_executor = _Executor(results=lambda n: f"attempt {n}: still failing")

    messages = await _collect(client)

    assert not _stopped(messages)
    assert len(session.payloads) == 8  # ran to max_turns
    assert _nudged_at(session.payloads) == []


class _OllamaResponse:
    def __init__(self, line: str):
        self.status = 200
        self._line = line

    async def text(self):
        return ""

    @property
    def content(self):
        async def _iter():
            yield self._line.encode("utf-8")

        return _iter()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _OllamaSession:
    def __init__(self):
        self.payloads: list[dict] = []

    def post(self, url, json=None, timeout=None, *, allow_redirects=True):  # noqa: A002
        self.payloads.append({"messages": [dict(m) for m in json["messages"]]})
        return _OllamaResponse(
            _dumps(
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "function": {
                                    "name": "read_file",
                                    "arguments": {"path": "a.py"},
                                }
                            }
                        ],
                    },
                    "done": True,
                }
            )
            + "\n"
        )


@pytest.mark.asyncio
async def test_the_ollama_loop_nudges_then_stops(monkeypatch):
    monkeypatch.setattr(LocalAgentClient, "_loaded_model_placement", lambda self: None)
    client = LocalAgentClient(model="llama3.3", max_turns=50)
    session = _OllamaSession()
    client._http_client = session
    client._model_max_ctx = None
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    client._tool_executor = _Executor()

    messages = await _collect(client)

    assert _stopped(messages)
    assert len(session.payloads) == REPEATS_BEFORE_STOP
    assert _nudged_at(session.payloads)[0] == REPEATS_BEFORE_NUDGE


@pytest.mark.asyncio
async def test_the_windsurf_text_mode_loop_nudges_then_stops(monkeypatch):
    import integrations.windsurf_proxy.cascade_client as cascade
    import integrations.windsurf_proxy.models as models

    sent: list[list[dict]] = []

    async def fake_cascade_chat(*, credentials, messages, model_enum, model_uid):
        sent.append([dict(m) for m in messages])
        return '<tool_call>{"name": "read_file", "arguments": {"path": "a.py"}}</tool_call>'

    monkeypatch.setattr(cascade, "cascade_chat", fake_cascade_chat)
    monkeypatch.setattr(models, "requires_cascade", lambda name: True)

    client = WindsurfAgentClient(model="swe-1.6", max_turns=50)
    client._use_local_grpc = True
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    client._tool_executor = _Executor()

    messages = await _collect(client)

    assert _stopped(messages)
    assert len(sent) == REPEATS_BEFORE_STOP
    assert any(m.get("content") == PROGRESS_NUDGE for m in sent[REPEATS_BEFORE_NUDGE])
    # Text mode reports no usage: the ledger is empty, not the last response's.
    assert client.usage_ledger is not None and client.usage_ledger.calls == []
    assert not any(
        block.type == ContentBlockType.TEXT
        and block.text == "(No response from Windsurf)"
        for msg in messages
        for block in msg.content
    )
