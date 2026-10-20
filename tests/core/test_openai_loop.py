"""The OpenAI chat-completions loop, run end to end against a fake session.

Google, the OpenAI-compatible providers and LM Studio run this same loop. It
had tests for its usage ledger and its no-progress stop only; these pin the
rest before it moves into the shared loop (harness lot 1b-ii): the request,
what is yielded and in which order, what goes back to the model, the totals,
and every way a response ends. No network.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from core.agent_client import (
    AgentMessage,
    CompatibleProviderAgentClient,
    ContentBlock,
    ContentBlockType,
    GoogleAgentClient,
    LocalAgentClient,
    MessageRole,
    OpenAIAgentClient,
)
from core.llm_optimization import truncate_tool_result
from harness.domain import CallUsage
from harness.domain.progress import NO_PROGRESS_STOP, PROGRESS_NUDGE

ELIDED = "[tool result elided to save context — re-run the tool if needed]"


class _Executor:
    def __init__(self, results=None):
        self.calls: list[tuple[str, Any]] = []
        self._results = results

    async def execute(self, name, args):
        self.calls.append((name, args))
        if self._results is None:
            return "x = 1\n"
        result = self._results(len(self.calls), name, args)
        if isinstance(result, Exception):
            raise result
        return result


class _Response:
    def __init__(self, status: int = 200, data: Any = None, body: str = ""):
        self.status = status
        self._data = data
        self._body = body

    async def json(self):
        return self._data

    async def text(self):
        return self._body

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


class _Session:
    """Serves the scripted answers, one per POST (the last one repeats)."""

    def __init__(self, answers):
        self._answers = list(answers)
        self.urls: list[str] = []
        self.payloads: list[dict] = []
        self.options: list[dict] = []

    def post(self, url, json=None, **options):  # noqa: A002 - aiohttp's name
        self.urls.append(url)
        self.payloads.append(_copy(json))
        self.options.append(options)
        answer = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer


def _copy(payload: dict) -> dict:
    return json.loads(json.dumps(payload))


def _choice(content="", tool_calls=None, finish="stop", usage=None) -> _Response:
    message: dict[str, Any] = {"content": content}
    if tool_calls is not None:
        message["tool_calls"] = tool_calls
    data: dict[str, Any] = {"choices": [{"message": message, "finish_reason": finish}]}
    if usage is not None:
        data["usage"] = usage
    return _Response(200, data)


def _call(name="read_file", args='{"path": "a.py"}', call_id="call_1") -> dict:
    call: dict[str, Any] = {"function": {"name": name, "arguments": args}}
    if call_id is not None:
        call["id"] = call_id
    return call


def _shape(messages: list[AgentMessage]) -> list[tuple]:
    shape = []
    for msg in messages:
        assert len(msg.content) == 1
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


@pytest.fixture
def costs(monkeypatch):
    """Records what the loop prices, instead of reading the catalog."""
    seen: list[tuple] = []

    def fake_cost(model, input_tokens, output_tokens, provider="openai"):
        seen.append((model, input_tokens, output_tokens, provider))
        return 0.42

    monkeypatch.setattr("core.agent_clients.openai._openai_cost_usd", fake_cost)
    return seen


def _client(answers, *, max_turns=50, executor=None, **kwargs):
    client = OpenAIAgentClient(
        api_key="sk-test-0000", system_prompt="be brief", max_turns=max_turns, **kwargs
    )
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    client._tool_executor = executor if executor is not None else _Executor()
    session = _Session(answers)
    client._http_client = session
    return client, session


async def _collect(client, prompt: str = "fix it") -> list[AgentMessage]:
    await client.query(prompt)
    return [msg async for msg in client.receive_response()]


@pytest.mark.asyncio
async def test_no_api_key_ends_before_any_request(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    client = OpenAIAgentClient()
    session = _Session([_choice("Done.")])
    client._http_client = session

    messages = await _collect(client)

    assert _shape(messages) == [
        ("system", "text", "OpenAI auth error: OPENAI_API_KEY not set.")
    ]
    assert session.payloads == []
    assert client.usage_ledger is None
    # The prompt stays queued.
    assert client._pending_query == "fix it"


@pytest.mark.asyncio
async def test_a_final_answer_ends_the_response(costs):
    client, session = _client(
        [
            _choice(
                "Done.",
                usage={
                    "prompt_tokens": 2_000,
                    "completion_tokens": 30,
                    "prompt_tokens_details": {"cached_tokens": 1_536},
                },
            )
        ]
    )

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "Done.")]
    assert session.urls == ["https://api.openai.com/v1/chat/completions"]
    assert session.options == [
        {"headers": {"Authorization": "Bearer sk-test-0000"}, "allow_redirects": True}
    ]
    assert session.payloads[0] == {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "be brief"},
            {"role": "user", "content": "fix it"},
        ],
        "stream": False,
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "",
                    "parameters": {},
                },
            }
        ],
        "tool_choice": "auto",
    }
    assert client.last_usage == {
        "input_tokens": 2_000,
        "output_tokens": 30,
        "cost_usd": 0.42,
    }
    assert costs == [("gpt-4o", 2_000, 30, "openai")]
    assert client.usage_ledger.calls == [CallUsage(2_000, 1_536, None, 30)]
    assert client.last_context_tokens == 2_000


@pytest.mark.asyncio
async def test_the_openai_only_fields_are_sent_when_set(costs):
    client, session = _client(
        [_choice("Done.")], reasoning_effort="high", prompt_cache_key="task-1"
    )
    client._tool_definitions = []

    await _collect(client)

    payload = session.payloads[0]
    assert payload["reasoning_effort"] == "high"
    assert payload["prompt_cache_key"] == "task-1"
    assert "tools" not in payload and "tool_choice" not in payload


@pytest.mark.asyncio
async def test_an_offline_only_client_refuses_redirects(costs):
    client, session = _client([_choice("Done.")])
    client._offline_only = True

    await _collect(client)

    assert session.options[0]["allow_redirects"] is False


@pytest.mark.asyncio
async def test_a_tool_turn_is_yielded_executed_and_sent_back(costs):
    tool_calls = [_call(call_id="call_7")]
    executor = _Executor()
    client, session = _client(
        [
            _choice(
                "Reading.",
                tool_calls,
                "tool_calls",
                usage={"prompt_tokens": 1_000, "completion_tokens": 10},
            ),
            _choice("Done.", usage={"prompt_tokens": 1_500, "completion_tokens": 20}),
        ],
        executor=executor,
    )

    messages = await _collect(client)

    assert _shape(messages) == [
        ("assistant", "text", "Reading."),
        ("assistant", "tool_use", "read_file", "call_7", {"path": "a.py"}),
        ("assistant", "tool_result", "call_7", False, "x = 1\n"),
        ("assistant", "text", "Done."),
    ]
    assert executor.calls == [("read_file", {"path": "a.py"})]
    assert session.payloads[1]["messages"][2:] == [
        {"role": "assistant", "content": "Reading.", "tool_calls": tool_calls},
        {"role": "tool", "tool_call_id": "call_7", "content": "x = 1\n"},
    ]
    assert client.last_usage == {
        "input_tokens": 2_500,
        "output_tokens": 30,
        "cost_usd": 0.42,
    }
    assert costs == [("gpt-4o", 2_500, 30, "openai")]


@pytest.mark.asyncio
async def test_odd_calls_failing_tools_and_long_results(costs):
    long = "a" * 9_000 + "b" * 9_000 + "VERDICT"

    def results(n, name, args):
        return RuntimeError("boom") if n == 1 else long

    tool_calls = [_call(args="not json", call_id=None), _call(call_id="call_2")]
    client, session = _client(
        [_choice("", tool_calls, "tool_calls"), _choice("Done.")],
        executor=_Executor(results),
    )

    messages = await _collect(client)

    assert _shape(messages)[:4] == [
        ("assistant", "tool_use", "read_file", "call_0_read_file", {}),
        ("assistant", "tool_result", "call_0_read_file", True, "Tool error: boom"),
        ("assistant", "tool_use", "read_file", "call_2", {"path": "a.py"}),
        ("assistant", "tool_result", "call_2", False, long),
    ]
    assert session.payloads[1]["messages"][2:] == [
        {"role": "assistant", "tool_calls": tool_calls},
        {
            "role": "tool",
            "tool_call_id": "call_0_read_file",
            "content": "Tool error: boom",
        },
        {
            "role": "tool",
            "tool_call_id": "call_2",
            "content": truncate_tool_result(long),
        },
    ]


@pytest.mark.asyncio
async def test_without_an_executor_every_call_fails(costs):
    client, _session = _client([_choice("", [_call()], "tool_calls"), _choice("Done.")])
    client._tool_executor = None

    messages = await _collect(client)

    assert _shape(messages)[1] == (
        "assistant",
        "tool_result",
        "call_1",
        True,
        "Tool executor not available",
    )


class _Mcp:
    def __init__(self, fail: bool = False):
        self.calls: list[tuple[str, Any]] = []
        self._fail = fail

    def has_tool(self, name):
        return name == "hf_search"

    async def call(self, name, args):
        self.calls.append((name, args))
        if self._fail:
            raise RuntimeError("server gone")
        return {"hits": 1}


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_an_mcp_tool_goes_to_its_server_not_the_executor(costs, fail):
    executor = _Executor()
    client, _session = _client(
        [
            _choice(
                "",
                [_call("hf_search", '{"q": "x"}', "call_m"), _call(call_id="call_r")],
                "tool_calls",
            ),
            _choice("Done."),
        ],
        executor=executor,
    )
    mcp = _Mcp(fail)
    client._mcp_manager = mcp

    messages = await _collect(client)

    assert mcp.calls == [("hf_search", {"q": "x"})]
    assert executor.calls == [("read_file", {"path": "a.py"})]
    expected = (
        ("call_m", True, "MCP tool error: server gone")
        if fail
        else ("call_m", False, "{'hits': 1}")
    )
    assert _shape(messages)[1][2:] == expected


@pytest.mark.asyncio
async def test_an_http_error_ends_the_response_without_totals(costs):
    client, session = _client([_Response(500, body="overloaded")])

    messages = await _collect(client)

    assert _shape(messages) == [
        ("system", "text", "OpenAI API error (500): overloaded")
    ]
    assert len(session.payloads) == 1
    assert client.last_usage is None
    assert costs == []


@pytest.mark.asyncio
async def test_a_failed_request_is_described_by_the_client(costs):
    client, _session = _client([RuntimeError("socket closed")])

    messages = await _collect(client)

    assert _shape(messages) == [("system", "text", "OpenAI API error: socket closed")]
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_lm_studio_names_the_local_server_when_it_is_down(costs, monkeypatch):
    client = LocalAgentClient(
        model="local-model", base_url="http://127.0.0.1:1234", api_format="openai"
    )
    session = _Session([OSError("Cannot connect to host 127.0.0.1:1234")])
    client._http_client = session

    messages = await _collect(client)

    assert session.urls == ["http://127.0.0.1:1234/v1/chat/completions"]
    assert session.options[0]["headers"] == {"Authorization": "Bearer local"}
    assert len(messages) == 1 and messages[0].role == MessageRole.SYSTEM
    assert (
        messages[0]
        .content[0]
        .text.startswith("⚠️ Ollama ne répond pas sur http://127.0.0.1:1234")
    )


@pytest.mark.asyncio
async def test_empty_choices_end_the_response_without_totals(costs):
    client, _session = _client(
        [
            _Response(
                200,
                {"choices": [], "usage": {"prompt_tokens": 9, "completion_tokens": 0}},
            )
        ]
    )

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "(Empty response from OpenAI)")]
    assert client.usage_ledger.calls == [CallUsage(9, None, None, 0)]
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_a_reply_with_nothing_in_it(costs):
    client, _session = _client([_choice(None)])

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "(No response from OpenAI)")]
    assert client.last_usage == {
        "input_tokens": 0,
        "output_tokens": 0,
        "cost_usd": 0.42,
    }
    # Nothing reported: nothing measured.
    assert client.usage_ledger.calls == []
    assert client.last_context_tokens is None


@pytest.mark.asyncio
async def test_max_turns_ends_with_the_totals(costs):
    client, session = _client(
        [
            _choice(
                "",
                [_call()],
                "tool_calls",
                usage={"prompt_tokens": 10, "completion_tokens": 1},
            )
        ],
        max_turns=3,
        executor=_Executor(lambda n, *_: f"attempt {n}"),
    )

    messages = await _collect(client)

    assert len(session.payloads) == 3
    assert _shape(messages)[-1] == (
        "assistant",
        "tool_result",
        "call_1",
        False,
        "attempt 3",
    )
    assert client.last_usage == {
        "input_tokens": 30,
        "output_tokens": 3,
        "cost_usd": 0.42,
    }


@pytest.mark.asyncio
async def test_a_no_progress_stop_ends_with_the_totals(costs):
    client, session = _client(
        [
            _choice(
                "",
                [_call()],
                "tool_calls",
                usage={"prompt_tokens": 10, "completion_tokens": 1},
            )
        ]
    )

    messages = await _collect(client)

    turns = len(session.payloads)
    assert _shape(messages)[-1] == ("system", "text", NO_PROGRESS_STOP)
    # The nudge is the last message of the request after the third turn.
    assert session.payloads[3]["messages"][-1] == {
        "role": "user",
        "content": PROGRESS_NUDGE,
    }
    assert client.last_usage == {
        "input_tokens": 10 * turns,
        "output_tokens": turns,
        "cost_usd": 0.42,
    }


@pytest.mark.asyncio
async def test_old_tool_results_are_cleared_past_the_budget(costs, monkeypatch):
    monkeypatch.setenv("LLM_HISTORY_CHAR_BUDGET", "50000")
    client, session = _client(
        [_choice("", [_call()], "tool_calls")],
        max_turns=8,
        executor=_Executor(lambda n, *_: f"{n}" + "z" * 12_000),
    )

    await _collect(client)

    elided = [
        sum(m["content"] == ELIDED for m in payload["messages"] if m["role"] == "tool")
        for payload in session.payloads
    ]
    assert elided == [0, 0, 0, 0, 0, 1, 2, 3]
    assert session.payloads[-1]["messages"][1] == {"role": "user", "content": "fix it"}


@pytest.mark.asyncio
async def test_a_resumed_history_comes_after_the_system_prompt(costs):
    client, session = _client([_choice("Done.")])
    await client.resume(
        [
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="earlier")],
            )
        ]
    )

    await _collect(client)

    messages = session.payloads[0]["messages"]
    assert [m["role"] for m in messages] == ["system", "system", "user"]
    assert "earlier" in messages[1]["content"]


@pytest.mark.asyncio
async def test_the_ledger_restarts_before_the_first_message(costs):
    usage = {"prompt_tokens": 10, "completion_tokens": 1}
    client, _session = _client([_choice("Done.", usage=usage)])
    await _collect(client)
    await client.query("again")

    async for _ in client.receive_response():
        assert client.usage_ledger.calls == [CallUsage(10, None, None, 1)]


@pytest.mark.asyncio
async def test_google_and_compatible_providers_run_the_same_loop(costs, monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "test-google-0000")
    google = GoogleAgentClient()
    google._http_client = _Session([_choice("Done.")])
    compatible = CompatibleProviderAgentClient(
        provider="mistral",
        model="mistral-large",
        api_key="sk-test-0000",
        base_url="https://api.mistral.test/v1",
    )
    compatible._http_client = _Session([_choice("Done.")])

    for client in (google, compatible):
        assert _shape(await _collect(client)) == [("assistant", "text", "Done.")]

    assert google._http_client.urls == [
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    ]
    assert compatible._http_client.urls == [
        "https://api.mistral.test/v1/chat/completions"
    ]
    assert [seen[3] for seen in costs] == ["google", "mistral"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "data",
    [
        {"choices": [{"message": {"content": "hi", "tool_calls": None}}]},
        {"usage": None, "choices": [{"message": {"content": "hi"}}]},
        {"choices": [{"message": {"content": "hi"}, "finish_reason": None}]},
    ],
)
async def test_a_null_field_ends_the_turn(costs, data):
    """An OpenAI-compatible endpoint may send a field as ``null``. The turn
    ends with its text: ``"tool_calls": null`` crashed the turn's log line,
    ``"usage": null`` the usage reading."""
    client, _session = _client([_Response(200, data)])

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "hi")]
