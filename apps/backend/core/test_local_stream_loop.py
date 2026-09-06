"""The Ollama turn, end to end, against a fake HTTP session.

The turn is streamed so the heartbeat can report what the server has actually
produced. Non-streaming stayed reachable — a server too old to do tool calling
over a stream refuses the request — and both shapes fold through the same
accumulator, so the tests below pin the behaviour of both paths and of the
fallback between them. No local server is contacted.
"""

from __future__ import annotations

import json

import pytest
from core.agent_client import ContentBlockType, LocalAgentClient, MessageRole


class _FakeResponse:
    def __init__(self, status: int, lines: list[str], body: str = ""):
        self.status = status
        self._lines = lines
        self._body = body

    async def text(self) -> str:
        return self._body

    @property
    def content(self):
        async def _iter():
            for line in self._lines:
                yield line.encode("utf-8")

        return _iter()

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _FakeSession:
    """Serves one canned response per POST and records the payloads sent."""

    def __init__(self, responses: list[_FakeResponse]):
        self._responses = list(responses)
        self.payloads: list[dict] = []

    def post(self, url, json=None, timeout=None):  # noqa: A002 - aiohttp's name
        self.payloads.append(json)
        return self._responses.pop(0)


def _chunk(content: str = "", **extra) -> str:
    return json.dumps({"message": {"content": content}, **extra}) + "\n"


def _client(session: _FakeSession) -> LocalAgentClient:
    client = LocalAgentClient(model="llama3.3")
    client._http_client = session
    client._tool_definitions = [
        {"name": "read_file", "description": "read", "parameters": {}}
    ]
    return client


async def _collect(client: LocalAgentClient, prompt: str = "do the thing"):
    await client.query(prompt)
    return [msg async for msg in client.receive_response()]


def _texts(messages, role) -> list[str]:
    return [
        block.text or ""
        for msg in messages
        if msg.role == role
        for block in msg.content
        if block.type == ContentBlockType.TEXT
    ]


@pytest.mark.asyncio
async def test_streamed_chunks_become_one_assistant_turn():
    session = _FakeSession(
        [
            _FakeResponse(
                200,
                [
                    _chunk("I read "),
                    _chunk("the file."),
                    _chunk("", done=True, prompt_eval_count=900, eval_count=12),
                ],
            ),
            # Narrating without calling a tool earns one nudge; the empty reply
            # to it ends the loop.
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)

    messages = await _collect(client)

    assert "I read the file." in _texts(messages, MessageRole.ASSISTANT)
    assert session.payloads[0]["stream"] is True
    assert client.last_usage == {
        "input_tokens": 900,
        "output_tokens": 12,
        "cost_usd": 0.0,
    }


@pytest.mark.asyncio
async def test_context_size_is_reported_before_the_first_request():
    """The size of the prompt against the window is the one number that
    explains a stalled local build, and it is knowable before sending."""
    session = _FakeSession(
        [
            _FakeResponse(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)

    status_lines = _texts(await _collect(client), MessageRole.SYSTEM)

    assert any("tokens estimés" in line for line in status_lines)


@pytest.mark.asyncio
async def test_oversized_prompt_is_flagged_rather_than_silently_truncated(
    monkeypatch,
):
    monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "2048")
    session = _FakeSession(
        [
            _FakeResponse(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)

    status_lines = _texts(await _collect(client, "x" * 40_000), MessageRole.SYSTEM)

    assert any("dépasse la fenêtre de contexte" in line for line in status_lines)


@pytest.mark.asyncio
async def test_streamed_tool_call_is_executed():
    class _Executor:
        def __init__(self):
            self.calls: list[tuple[str, dict]] = []

        async def execute(self, name, args):
            self.calls.append((name, args))
            return "file contents"

    session = _FakeSession(
        [
            _FakeResponse(
                200,
                [
                    json.dumps(
                        {
                            "message": {
                                "content": "",
                                "tool_calls": [
                                    {
                                        "function": {
                                            "name": "read_file",
                                            "arguments": {"path": "main.py"},
                                        }
                                    }
                                ],
                            }
                        }
                    )
                    + "\n",
                    _chunk("", done=True),
                ],
            ),
            _FakeResponse(200, [_chunk("Done.", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    executor = _Executor()
    client._tool_executor = executor

    messages = await _collect(client)

    assert executor.calls == [("read_file", {"path": "main.py"})]
    assert any(
        block.type == ContentBlockType.TOOL_RESULT
        for msg in messages
        for block in msg.content
    )
    # The tool result went back to the server as a native `tool` message.
    assert session.payloads[1]["messages"][-1]["role"] == "tool"


@pytest.mark.asyncio
async def test_server_without_streamed_tool_calling_falls_back_once():
    session = _FakeSession(
        [
            _FakeResponse(
                400, [], body='{"error":"tools not supported with stream=true"}'
            ),
            _FakeResponse(200, [_chunk("Done.", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)

    messages = await _collect(client)

    assert [p["stream"] for p in session.payloads] == [True, False, False]
    assert "Done." in _texts(messages, MessageRole.ASSISTANT)


@pytest.mark.asyncio
async def test_streaming_can_be_turned_off_by_env(monkeypatch):
    monkeypatch.setenv("OLLAMA_STREAM", "0")
    session = _FakeSession(
        [
            _FakeResponse(200, [_chunk("Done.", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)

    await _collect(client)

    assert session.payloads[0]["stream"] is False


@pytest.mark.asyncio
async def test_mid_stream_error_is_surfaced_not_swallowed():
    """Ollama can fail after the 200 is on the wire. The partial content is not
    a finished turn, and reporting it as one is how a phase 'succeeds' with
    half an answer."""
    session = _FakeSession(
        [
            _FakeResponse(
                200,
                [
                    _chunk("I was about to"),
                    json.dumps({"error": "model runner has terminated"}) + "\n",
                ],
            )
        ]
    )
    client = _client(session)

    status_lines = _texts(await _collect(client), MessageRole.SYSTEM)

    assert any("model runner has terminated" in line for line in status_lines)
