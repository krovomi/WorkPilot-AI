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
        self.redirect_options: list[bool] = []

    def post(self, url, json=None, timeout=None, *, allow_redirects=True):  # noqa: A002 - aiohttp's name
        self.payloads.append(json)
        self.redirect_options.append(allow_redirects)
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
    assert session.redirect_options == [False] * len(session.payloads)
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
async def test_the_window_is_sized_to_the_prompt(monkeypatch):
    """A prompt bigger than the 8192 floor raises the window instead of being
    quietly beheaded by the server — the failure the user actually hit."""
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
    session = _FakeSession(
        [
            _FakeResponse(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 131_072

    await _collect(client, "x" * 30_000)  # ~10k tokens

    assert session.payloads[0]["options"]["num_ctx"] == 16_384
    # Every turn asks for the SAME window: a num_ctx that moves between turns
    # makes Ollama evict and reload the model.
    assert session.payloads[1]["options"]["num_ctx"] == 16_384


@pytest.mark.asyncio
async def test_a_prompt_beyond_the_ceiling_is_flagged(monkeypatch):
    monkeypatch.setenv("OLLAMA_CONTEXT_LENGTH", "8192")
    session = _FakeSession(
        [
            _FakeResponse(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 131_072

    status_lines = _texts(await _collect(client, "x" * 40_000), MessageRole.SYSTEM)

    assert any("ne tient pas dans la fenêtre" in line for line in status_lines)
    # The ceiling is ours, so the remedy named is the ceiling.
    assert any("OLLAMA_CONTEXT_LENGTH" in line for line in status_lines)


@pytest.mark.asyncio
async def test_a_model_that_cannot_go_wider_says_so_instead(monkeypatch):
    """Raising a ceiling the model cannot use is not a remedy — it is a wasted
    hour. When the model's own limit is what binds, say to change the model."""
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
    session = _FakeSession(
        [
            _FakeResponse(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 8_192

    status_lines = _texts(await _collect(client, "x" * 40_000), MessageRole.SYSTEM)

    assert any("ne gère pas plus de 8192 tokens" in line for line in status_lines)
    assert not any("OLLAMA_CONTEXT_LENGTH" in line for line in status_lines)


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


@pytest.mark.asyncio
async def test_a_silent_turn_reports_where_the_model_is_loaded(monkeypatch):
    """The heartbeat's first pass with nothing to show asks /api/ps.

    At 30 seconds, not at five minutes: a model spilled onto the CPU is
    knowable as soon as it is resident, and those four minutes were the whole
    complaint.
    """
    monkeypatch.setattr(
        "core.agent_client._LOCAL_HEARTBEAT_SECONDS", 0.01, raising=True
    )

    class _SlowFirstChunk(_FakeResponse):
        """A response whose first chunk arrives after a heartbeat has fired."""

        @property
        def content(self):
            async def _iter():
                import asyncio

                await asyncio.sleep(0.05)
                for line in self._lines:
                    yield line.encode("utf-8")

            return _iter()

    session = _FakeSession(
        [
            _SlowFirstChunk(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 131_072
    monkeypatch.setattr(
        LocalAgentClient,
        "_loaded_model_placement",
        lambda _self: {
            "loaded": True,
            "size": 40 * 1024**3,
            "size_vram": 10 * 1024**3,
            "parameter_size": "70.6B",
        },
        raising=True,
    )

    status_lines = _texts(await _collect(client), MessageRole.SYSTEM)

    diagnoses = [line for line in status_lines if line.startswith("🧠")]
    assert len(diagnoses) == 1, "one diagnosis per session, not one per heartbeat"
    assert "ne tient pas dans la VRAM" in diagnoses[0]


@pytest.mark.asyncio
async def test_a_model_still_loading_is_asked_again(monkeypatch):
    """`/api/ps` lists nothing while the model is still being read off disk.

    Latching on that first empty answer would lose the diagnosis for the whole
    session — exactly the sessions that need it most.
    """
    monkeypatch.setattr(
        "core.agent_client._LOCAL_HEARTBEAT_SECONDS", 0.01, raising=True
    )

    class _SlowFirstChunk(_FakeResponse):
        @property
        def content(self):
            async def _iter():
                import asyncio

                await asyncio.sleep(0.08)
                for line in self._lines:
                    yield line.encode("utf-8")

            return _iter()

    answers = [
        None,
        None,
        {"loaded": True, "size": 8, "size_vram": 8, "parameter_size": "7B"},
    ]
    calls = []

    def _placement(_self):
        calls.append(1)
        return answers[min(len(calls) - 1, len(answers) - 1)]

    session = _FakeSession(
        [
            _SlowFirstChunk(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 131_072
    monkeypatch.setattr(
        LocalAgentClient, "_loaded_model_placement", _placement, raising=True
    )

    status_lines = _texts(await _collect(client), MessageRole.SYSTEM)

    assert len(calls) >= 3, "the probe retries until the server can answer"
    assert sum(line.startswith("🧠") for line in status_lines) == 1


@pytest.mark.asyncio
async def test_a_model_absent_from_api_ps_is_reported(monkeypatch):
    """`ollama ps` empty while a request is in flight is the surprising fact,
    and the first version of the probe printed nothing for it."""
    monkeypatch.setattr(
        "core.agent_client._LOCAL_HEARTBEAT_SECONDS", 0.01, raising=True
    )
    monkeypatch.setattr("core.agent_client._LOCAL_NOT_LOADED_GRACE", 0, raising=True)

    class _SlowFirstChunk(_FakeResponse):
        @property
        def content(self):
            async def _iter():
                import asyncio

                await asyncio.sleep(0.05)
                for line in self._lines:
                    yield line.encode("utf-8")

            return _iter()

    session = _FakeSession(
        [
            _SlowFirstChunk(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 131_072
    monkeypatch.setattr(
        LocalAgentClient,
        "_loaded_model_placement",
        lambda _self: {"loaded": False, "others": ["qwen2.5-coder:7b"]},
        raising=True,
    )

    status_lines = _texts(await _collect(client), MessageRole.SYSTEM)

    absent = [line for line in status_lines if line.startswith("🧠")]
    assert len(absent) == 1
    assert "ne rapporte pas « llama3.3 »" in absent[0]
    assert "qwen2.5-coder:7b" in absent[0]


@pytest.mark.asyncio
async def test_a_cold_start_is_not_flagged_before_the_grace_period(monkeypatch):
    """A large model is legitimately absent from /api/ps while its weights are
    read off disk. Warning on the first heartbeat would cry wolf every run."""
    monkeypatch.setattr(
        "core.agent_client._LOCAL_HEARTBEAT_SECONDS", 0.01, raising=True
    )

    class _SlowFirstChunk(_FakeResponse):
        @property
        def content(self):
            async def _iter():
                import asyncio

                await asyncio.sleep(0.05)
                for line in self._lines:
                    yield line.encode("utf-8")

            return _iter()

    session = _FakeSession(
        [
            _SlowFirstChunk(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 131_072
    monkeypatch.setattr(
        LocalAgentClient,
        "_loaded_model_placement",
        lambda _self: {"loaded": False, "others": []},
        raising=True,
    )

    status_lines = _texts(await _collect(client), MessageRole.SYSTEM)

    assert not any(line.startswith("🧠") for line in status_lines)


@pytest.mark.asyncio
async def test_the_server_url_is_in_the_context_line(monkeypatch):
    """Which daemon the app opened a socket to is invisible from a terminal,
    and it is the one fact that ends a 'nothing is loaded' investigation."""
    monkeypatch.delenv("OLLAMA_CONTEXT_LENGTH", raising=False)
    session = _FakeSession(
        [
            _FakeResponse(200, [_chunk("done", done=True)]),
            _FakeResponse(200, [_chunk("", done=True)]),
        ]
    )
    client = _client(session)
    client._model_max_ctx = 131_072

    status_lines = _texts(await _collect(client), MessageRole.SYSTEM)

    assert any("serveur http://127.0.0.1:11434" in line for line in status_lines)
