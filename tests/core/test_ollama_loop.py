"""The Ollama loop: what ``test_local_stream_loop`` leaves out (harness lot 1b-ii).

That file pins the streamed turn, the heartbeat and the context sizing. These
pin the rest before the loop moves into the shared one: the nudge of a model
that narrates instead of acting, tool calls recovered from the text, what goes
back to the server, pulling a missing model, connection retries and the
totals. No local server is contacted.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from core.agent_client import (
    ContentBlockType,
    LocalAgentClient,
    LocalModelRuntimeError,
    MessageRole,
)
from core.agent_clients.local import _TOOL_USE_NUDGE
from core.llm_optimization import truncate_tool_result
from harness.domain import CallUsage
from harness.domain.progress import NO_PROGRESS_STOP

ELIDED = "[tool result elided to save context — re-run the tool if needed]"


@pytest.fixture(autouse=True)
def no_metadata_probes(monkeypatch):
    monkeypatch.setattr(LocalAgentClient, "_loaded_model_placement", lambda self: None)

    def unexpected_network(*args, **kwargs):
        pytest.fail("These tests must not contact a real Ollama server")

    monkeypatch.setattr("urllib.request.urlopen", unexpected_network)


class _Response:
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


class _Session:
    """Serves the scripted answers, one per POST (the last one repeats)."""

    def __init__(self, answers):
        self._answers = list(answers)
        self.payloads: list[dict] = []

    def post(self, url, json=None, timeout=None, *, allow_redirects=True):  # noqa: A002
        self.payloads.append(_copy(json))
        answer = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


def _copy(payload: dict) -> dict:
    return json.loads(json.dumps(payload))


def _reply(content: str = "", tool_calls=None, **counts) -> _Response:
    message: dict[str, Any] = {"content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    return _Response(
        200, [json.dumps({"message": message, "done": True, **counts}) + "\n"]
    )


def _call(name="read_file", arguments=None, **extra) -> dict:
    return {
        "function": {"name": name, "arguments": arguments or {"path": "a.py"}},
        **extra,
    }


class _Executor:
    def __init__(self, results=None):
        self.calls: list[tuple[str, Any]] = []
        self._results = results
        self.result_max_chars: int | None = None

    async def execute(self, name, args):
        self.calls.append((name, args))
        if self._results is None:
            return "x = 1\n"
        result = self._results(len(self.calls), name, args)
        if isinstance(result, Exception):
            raise result
        return result


def _client(answers, *, max_turns=50, executor=None, model="llama3.3"):
    client = LocalAgentClient(
        model=model, system_prompt="be brief", max_turns=max_turns
    )
    session = _Session(answers)
    client._http_client = session
    client._model_max_ctx = None
    client._tool_definitions = [
        {"name": "read_file", "description": "read", "parameters": {}}
    ]
    client._tool_executor = executor if executor is not None else _Executor()
    return client, session


async def _collect(client, prompt: str = "fix it"):
    await client.query(prompt)
    return [msg async for msg in client.receive_response()]


def _shape(messages) -> list[tuple]:
    """The messages after the context line, each as a tuple."""
    assert messages[0].role == MessageRole.SYSTEM
    assert messages[0].content[0].text.startswith("📐 Contexte envoyé")
    shape = []
    for msg in messages[1:]:
        block = msg.content[0]
        if block.type == ContentBlockType.TEXT:
            shape.append((msg.role.value, "text", block.text))
        elif block.type == ContentBlockType.TOOL_USE:
            shape.append(
                (
                    msg.role.value,
                    "tool_use",
                    block.tool_name,
                    block.tool_id,
                    block.tool_input,
                )
            )
        else:
            shape.append(
                (
                    msg.role.value,
                    "tool_result",
                    block.tool_use_id,
                    block.is_error,
                    block.result_content,
                )
            )
    return shape


@pytest.mark.asyncio
async def test_a_tool_turn_goes_back_in_the_native_shape():
    long = "a" * 9_000 + "b" * 9_000 + "VERDICT"
    tool_calls = [_call()]
    client, session = _client(
        [
            _reply("", tool_calls, prompt_eval_count=900, eval_count=12),
            _reply("Done.", prompt_eval_count=1_000, eval_count=5),
        ],
        executor=_Executor(lambda *_: long),
    )

    messages = await _collect(client)

    assert _shape(messages) == [
        ("assistant", "tool_use", "read_file", "call_0_0_read_file", {"path": "a.py"}),
        ("assistant", "tool_result", "call_0_0_read_file", False, long),
        ("assistant", "text", "Done."),
    ]
    assert session.payloads[1]["messages"][2:] == [
        {"role": "assistant", "content": "", "tool_calls": tool_calls},
        {
            "role": "tool",
            "tool_name": "read_file",
            "content": truncate_tool_result(
                long, limit=client._local_tool_result_cap()
            ),
        },
    ]
    assert client.usage_ledger.calls == [
        CallUsage(900, None, None, 12),
        CallUsage(1_000, None, None, 5),
    ]
    assert client.last_usage == {
        "input_tokens": 1_900,
        "output_tokens": 17,
        "cost_usd": 0.0,
    }
    assert client.last_context_tokens == 1_000


@pytest.mark.asyncio
async def test_string_arguments_ids_and_failing_tools():
    client, _session = _client(
        [
            _reply(
                "",
                [
                    _call(arguments='{"path": "b.py"}', id="tc_9"),
                    {"function": {"name": "list_files", "arguments": "not json"}},
                ],
            ),
            _reply("Done."),
        ],
        executor=_Executor(lambda n, *_: RuntimeError("boom") if n == 2 else "ok"),
    )

    messages = await _collect(client)

    assert _shape(messages)[:4] == [
        ("assistant", "tool_use", "read_file", "tc_9", {"path": "b.py"}),
        ("assistant", "tool_result", "tc_9", False, "ok"),
        ("assistant", "tool_use", "list_files", "call_0_1_list_files", {}),
        ("assistant", "tool_result", "call_0_1_list_files", True, "Tool error: boom"),
    ]


@pytest.mark.asyncio
async def test_without_an_executor_every_call_fails():
    client, _session = _client([_reply("", [_call()]), _reply("Done.")])
    client._tool_executor = None

    messages = await _collect(client)

    assert _shape(messages)[1][3:] == (True, "Tool executor not available")


@pytest.mark.asyncio
async def test_an_mcp_tool_goes_to_its_server():
    class _Mcp:
        def __init__(self):
            self.calls = []

        def has_tool(self, name):
            return name == "hf_search"

        async def call(self, name, args):
            self.calls.append((name, args))
            raise RuntimeError("server gone")

    executor = _Executor()
    client, _session = _client(
        [_reply("", [_call("hf_search", {"q": "x"}), _call()]), _reply("Done.")],
        executor=executor,
    )
    mcp = _Mcp()
    client._mcp_manager = mcp

    messages = await _collect(client)

    assert mcp.calls == [("hf_search", {"q": "x"})]
    assert executor.calls == [("read_file", {"path": "a.py"})]
    assert _shape(messages)[1][3:] == (True, "MCP tool error: server gone")


@pytest.mark.asyncio
async def test_a_model_that_narrates_is_nudged_once_then_acts():
    client, session = _client(
        [
            _reply("I will now read the file and fix it."),
            _reply("", [_call()]),
            _reply("Done."),
        ]
    )

    messages = await _collect(client)

    assert _shape(messages)[0] == (
        "assistant",
        "text",
        "I will now read the file and fix it.",
    )
    assert session.payloads[1]["messages"][2:] == [
        {"role": "assistant", "content": "I will now read the file and fix it."},
        {"role": "user", "content": _TOOL_USE_NUDGE},
    ]
    assert len(session.payloads) == 3
    assert client.tool_calling_unsupported is False


@pytest.mark.asyncio
async def test_a_model_that_keeps_narrating_is_given_up_on():
    client, session = _client(
        [_reply("I will read the file.", prompt_eval_count=50, eval_count=5)]
    )

    messages = await _collect(client)

    shape = _shape(messages)
    assert shape[:2] == [
        ("assistant", "text", "I will read the file."),
        ("assistant", "text", "I will read the file."),
    ]
    assert shape[2][0] == "system"
    assert shape[2][2].startswith(
        "⚠️ Le modèle local « llama3.3 » n'a appelé aucun outil"
    )
    assert len(session.payloads) == 2
    assert client.tool_calling_unsupported is True
    assert client.last_usage == {
        "input_tokens": 100,
        "output_tokens": 10,
        "cost_usd": 0.0,
    }


@pytest.mark.asyncio
async def test_a_model_waiting_for_a_human_after_acting_is_nudged():
    client, session = _client(
        [
            _reply("", [_call()]),
            _reply("Please run the tests and paste the output."),
            _reply("Done."),
        ]
    )

    await _collect(client)

    assert session.payloads[2]["messages"][-1] == {
        "role": "user",
        "content": _TOOL_USE_NUDGE,
    }


@pytest.mark.asyncio
async def test_a_tool_call_written_as_text_is_recovered():
    executor = _Executor()
    client, _session = _client(
        [
            _reply(
                'I will read it now: {"name": "read_file", "arguments": {"path": "a.py"}}'
            ),
            _reply("Done."),
        ],
        executor=executor,
    )

    messages = await _collect(client)

    assert _shape(messages)[:3] == [
        # The narration before the payload is kept, the payload is not.
        ("assistant", "text", "I will read it now:"),
        ("assistant", "tool_use", "read_file", "call_0_0_read_file", {"path": "a.py"}),
        ("assistant", "tool_result", "call_0_0_read_file", False, "x = 1\n"),
    ]
    assert executor.calls == [("read_file", {"path": "a.py"})]


@pytest.mark.asyncio
async def test_a_missing_model_is_pulled_then_the_turn_is_asked_again(monkeypatch):
    async def pull(self):
        yield ("progress", "📥 50 %")
        yield ("done", "")

    monkeypatch.setattr(LocalAgentClient, "_pull_ollama_model_stream", pull)
    client, session = _client(
        [
            _Response(404, [], body='{"error":"model \\"llama3.3\\" not found"}'),
            _reply("Done."),
        ]
    )
    # No tools offered: a prose answer is a normal end, not a stall to nudge.
    client._tool_definitions = []

    messages = await _collect(client)

    texts = [block.text for msg in messages[1:] for block in msg.content]
    assert texts[0].startswith("📥 Modèle « llama3.3 » non installé")
    assert texts[1:] == [
        "📥 50 %",
        "✅ Modèle « llama3.3 » téléchargé — reprise de la phase.",
        "Done.",
    ]
    assert len(session.payloads) == 2


@pytest.mark.asyncio
async def test_a_pull_spends_a_turn(monkeypatch):
    async def pull(self):
        yield ("done", "")

    monkeypatch.setattr(LocalAgentClient, "_pull_ollama_model_stream", pull)
    client, session = _client(
        [_Response(404, [], body="model not found"), _reply("Done.")], max_turns=1
    )

    await _collect(client)

    assert len(session.payloads) == 1
    assert client.last_usage == {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


@pytest.mark.asyncio
async def test_a_failed_pull_ends_the_response(monkeypatch):
    async def pull(self):
        yield ("error", "disk full")

    monkeypatch.setattr(LocalAgentClient, "_pull_ollama_model_stream", pull)
    client, session = _client([_Response(404, [], body="model not found")])

    messages = await _collect(client)

    assert messages[-1].content[0].text == (
        "Échec du téléchargement du modèle « llama3.3 » : disk full"
    )
    assert len(session.payloads) == 1
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_a_hosted_model_is_never_pulled(monkeypatch):
    async def pull(self):  # pragma: no cover - must not run
        raise AssertionError("a hosted model is never pulled")
        yield

    monkeypatch.setattr(LocalAgentClient, "_pull_ollama_model_stream", pull)
    client, _session = _client(
        [_Response(404, [], body="model not found")], model="claude-sonnet-4-5"
    )

    messages = await _collect(client)

    assert (
        messages[-1]
        .content[0]
        .text.startswith("« claude-sonnet-4-5 » est un modèle d'API")
    )
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_a_refused_connection_is_retried_twice_then_raised(monkeypatch):
    import asyncio

    sleeps: list[float] = []

    async def sleep(seconds):
        sleeps.append(seconds)

    monkeypatch.setattr(asyncio, "sleep", sleep)
    client, session = _client([OSError("Cannot connect to host 127.0.0.1:11434")])

    with pytest.raises(LocalModelRuntimeError, match="Ollama ne répond pas"):
        await _collect(client)

    assert len(session.payloads) == 3
    assert sleeps == [1.5, 3.0]


@pytest.mark.asyncio
async def test_a_retried_connection_spends_a_turn(monkeypatch):
    import asyncio

    async def sleep(seconds):
        return None

    monkeypatch.setattr(asyncio, "sleep", sleep)
    client, session = _client(
        [OSError("Cannot connect to host"), _reply("Done.")], max_turns=1
    )

    messages = await _collect(client)

    assert len(session.payloads) == 1
    assert len(messages) == 1  # the context line only
    assert client.last_usage == {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


@pytest.mark.asyncio
async def test_an_api_error_is_raised():
    client, _session = _client([_Response(500, [], body="boom")])

    with pytest.raises(LocalModelRuntimeError, match=r"Ollama API error \(500\): boom"):
        await _collect(client)
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_max_turns_ends_with_the_totals():
    client, session = _client(
        [_reply("", [_call()], prompt_eval_count=10, eval_count=1)],
        max_turns=3,
        executor=_Executor(lambda n, *_: f"attempt {n}"),
    )

    messages = await _collect(client)

    assert len(session.payloads) == 3
    assert _shape(messages)[-1][-1] == "attempt 3"
    assert client.last_usage == {
        "input_tokens": 30,
        "output_tokens": 3,
        "cost_usd": 0.0,
    }


@pytest.mark.asyncio
async def test_a_no_progress_stop_ends_with_the_totals():
    client, session = _client(
        [_reply("", [_call()], prompt_eval_count=10, eval_count=1)]
    )

    messages = await _collect(client)

    turns = len(session.payloads)
    assert _shape(messages)[-1] == ("system", "text", NO_PROGRESS_STOP)
    assert client.last_usage == {
        "input_tokens": 10 * turns,
        "output_tokens": turns,
        "cost_usd": 0.0,
    }


@pytest.mark.asyncio
async def test_old_tool_results_are_cleared_within_the_local_budget(monkeypatch):
    client, session = _client(
        [_reply("", [_call()])],
        max_turns=8,
        executor=_Executor(lambda n, *_: f"{n}" + "z" * 12_000),
    )
    # The budget is sized to the window, and each result to a fifth of it
    # (~4.9k chars at 8k tokens): a 20k budget is crossed after five turns.
    monkeypatch.setattr(client, "_local_history_budget", lambda: 20_000)

    await _collect(client)

    elided = [
        sum(m["content"] == ELIDED for m in payload["messages"] if m["role"] == "tool")
        for payload in session.payloads
    ]
    assert elided == [0, 0, 0, 0, 0, 1, 2, 3]


@pytest.mark.asyncio
async def test_the_ledger_restarts_before_the_first_message():
    client, _session = _client([_reply("Done.", prompt_eval_count=10, eval_count=1)])
    client._tool_definitions = []
    await _collect(client)
    await client.query("again")

    seen = []
    async for _ in client.receive_response():
        seen.append(list(client.usage_ledger.calls))

    # Empty at the context line, this response's call after it.
    assert seen == [[], [CallUsage(10, None, None, 1)]]
