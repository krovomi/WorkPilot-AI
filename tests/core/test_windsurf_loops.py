"""The two Windsurf loops, run end to end against fakes (harness lot 1b-ii).

REST mode speaks OpenAI chat completions with function calling. Text mode (an
``sk-ws-*`` key through the local IDE, gRPC) describes the tools in the system
prompt and parses ``<tool_call>`` tags out of the answer. Apart from the
no-progress tests, neither had a test that ran it; these pin what each loop
yields and in which order, what goes back to the model, what is measured, and
how each one ends. No network, no IDE.
"""

from __future__ import annotations

import json
from typing import Any

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
    WindsurfAgentClient,
)
from core.llm_optimization import truncate_tool_result
from harness.domain import CallUsage
from harness.domain.progress import NO_PROGRESS_STOP

ELIDED = "[tool result elided to save context — re-run the tool if needed]"

READ_FILE = {
    "name": "read_file",
    "description": "Read a file",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string", "description": "The path"}},
        "required": ["path"],
    },
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


def _shape(messages: list[AgentMessage]) -> list[tuple]:
    """Each message as a tuple: what the session runner sees, in order."""
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
        elif block.type == ContentBlockType.TOOL_RESULT:
            shape.append(
                (
                    msg.role.value,
                    "tool_result",
                    block.tool_use_id,
                    block.is_error,
                    block.result_content,
                )
            )
        else:  # pragma: no cover - not emitted by these loops
            shape.append((msg.role.value, block.type.value))
    return shape


async def _collect(client, prompt: str = "fix it") -> list[AgentMessage]:
    await client.query(prompt)
    return [msg async for msg in client.receive_response()]


# =============================================================================
# REST mode
# =============================================================================


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


class _RestSession:
    """Serves the scripted answers, one per POST, and records each request."""

    def __init__(self, answers):
        self._answers = list(answers)
        self.urls: list[str] = []
        self.payloads: list[dict] = []

    def post(self, url, json=None):  # noqa: A002 - aiohttp's name
        self.urls.append(url)
        # A deep copy: the loop keeps editing the list it sent.
        self.payloads.append(_copy(json))
        answer = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        if callable(answer):
            answer = answer(len(self.payloads))
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


def _rest_client(answers, *, max_turns=50, executor=None, monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.delenv("WINDSURF_BASE_URL", raising=False)
    client = WindsurfAgentClient(
        model="gpt-4o", system_prompt="be brief", max_turns=max_turns
    )
    client._use_local_grpc = False
    client._tool_definitions = [READ_FILE]
    client._tool_executor = executor if executor is not None else _Executor()
    session = _RestSession(answers)
    client._http_client = session
    return client, session


@pytest.mark.asyncio
async def test_rest_a_reply_without_tool_calls_ends_the_response(monkeypatch):
    client, session = _rest_client(
        [_choice("Done.", usage={"prompt_tokens": 1_200, "completion_tokens": 30})],
        monkeypatch=monkeypatch,
    )

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "Done.")]
    assert session.urls == ["https://windsurf.com/api/v1/chat/completions"]
    payload = session.payloads[0]
    assert payload["model"] == "gpt-4o"
    assert payload["stream"] is False
    assert payload["tool_choice"] == "auto"
    assert payload["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Read a file",
                "parameters": READ_FILE["parameters"],
            },
        }
    ]
    assert payload["messages"] == [
        {"role": "system", "content": "be brief"},
        {"role": "user", "content": "fix it"},
    ]
    # Windsurf bills credits, not tokens: the tokens are kept, the cost is 0.
    assert client.last_usage == {
        "input_tokens": 1_200,
        "output_tokens": 30,
        "cost_usd": 0.0,
    }
    assert client.usage_ledger.calls == [CallUsage(1_200, None, None, 30)]
    assert client.last_context_tokens == 1_200


@pytest.mark.asyncio
async def test_rest_without_tools_sends_no_tool_fields(monkeypatch):
    client, session = _rest_client([_choice("Done.")], monkeypatch=monkeypatch)
    client._tool_definitions = []

    await _collect(client)

    assert "tools" not in session.payloads[0]
    assert "tool_choice" not in session.payloads[0]


@pytest.mark.asyncio
async def test_rest_a_tool_turn_is_yielded_executed_and_sent_back(monkeypatch):
    tool_calls = [_call(call_id="call_7")]
    executor = _Executor()
    client, session = _rest_client(
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
        monkeypatch=monkeypatch,
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
    # Every call is measured; the totals cover the whole response.
    assert client.usage_ledger.calls == [
        CallUsage(1_000, None, None, 10),
        CallUsage(1_500, None, None, 20),
    ]
    assert client.last_usage == {
        "input_tokens": 2_500,
        "output_tokens": 30,
        "cost_usd": 0.0,
    }
    assert client.last_context_tokens == 1_500


@pytest.mark.asyncio
async def test_rest_an_assistant_turn_without_text_has_no_content_key(monkeypatch):
    tool_calls = [_call()]
    client, session = _rest_client(
        [_choice("", tool_calls, "tool_calls"), _choice("Done.")],
        monkeypatch=monkeypatch,
    )

    await _collect(client)

    assert session.payloads[1]["messages"][2] == {
        "role": "assistant",
        "tool_calls": tool_calls,
    }


@pytest.mark.asyncio
async def test_rest_a_long_result_is_cut_for_the_model_not_for_the_log(monkeypatch):
    long = "a" * 9_000 + "b" * 9_000 + "VERDICT"
    client, session = _rest_client(
        [_choice("", [_call()], "tool_calls"), _choice("Done.")],
        executor=_Executor(lambda *_: long),
        monkeypatch=monkeypatch,
    )

    messages = await _collect(client)

    assert _shape(messages)[1][4] == long
    sent = session.payloads[1]["messages"][-1]["content"]
    assert sent == truncate_tool_result(long)
    assert sent.endswith("VERDICT") and len(sent) < len(long)


@pytest.mark.asyncio
async def test_rest_odd_calls_and_failing_tools(monkeypatch):
    def results(n, name, args):
        return RuntimeError("boom") if n == 1 else "ok"

    client, session = _rest_client(
        [
            _choice(
                "",
                [
                    _call(args="not json", call_id=None),
                    _call(name="list_files", args="{}", call_id="call_2"),
                ],
                "tool_calls",
            ),
            _choice("Done."),
        ],
        executor=_Executor(results),
        monkeypatch=monkeypatch,
    )

    messages = await _collect(client)

    assert _shape(messages)[:4] == [
        # Unreadable arguments are an empty dict; a missing id is made up.
        ("assistant", "tool_use", "read_file", "call_0_read_file", {}),
        ("assistant", "tool_result", "call_0_read_file", True, "Tool error: boom"),
        ("assistant", "tool_use", "list_files", "call_2", {}),
        ("assistant", "tool_result", "call_2", False, "ok"),
    ]
    assert session.payloads[1]["messages"][-2:] == [
        {
            "role": "tool",
            "tool_call_id": "call_0_read_file",
            "content": "Tool error: boom",
        },
        {"role": "tool", "tool_call_id": "call_2", "content": "ok"},
    ]


@pytest.mark.asyncio
async def test_rest_without_an_executor_every_call_fails(monkeypatch):
    client, _session = _rest_client(
        [_choice("", [_call()], "tool_calls"), _choice("Done.")],
        monkeypatch=monkeypatch,
    )
    client._tool_executor = None

    messages = await _collect(client)

    assert _shape(messages)[1] == (
        "assistant",
        "tool_result",
        "call_1",
        True,
        "Tool executor not available (no project_dir)",
    )


@pytest.mark.asyncio
async def test_rest_empty_choices_end_the_response_without_totals(monkeypatch):
    client, session = _rest_client(
        [
            _Response(
                200,
                {"choices": [], "usage": {"prompt_tokens": 50, "completion_tokens": 0}},
            )
        ],
        monkeypatch=monkeypatch,
    )

    messages = await _collect(client)

    assert _shape(messages) == [
        ("assistant", "text", "(Empty response from Windsurf REST API)")
    ]
    assert len(session.payloads) == 1
    # The call is measured, but the response's totals are never set.
    assert client.usage_ledger.calls == [CallUsage(50, None, None, 0)]
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_rest_a_reply_with_nothing_in_it(monkeypatch):
    client, _session = _rest_client([_choice(None)], monkeypatch=monkeypatch)

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "(No response from Windsurf)")]
    assert client.last_usage == {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}
    assert client.usage_ledger.calls == []
    assert client.last_context_tokens is None


@pytest.mark.asyncio
async def test_rest_an_http_error_stops_probing_and_the_response(monkeypatch):
    client, session = _rest_client(
        [_Response(401, body="nope")], monkeypatch=monkeypatch
    )

    messages = await _collect(client)

    assert _shape(messages) == [
        ("system", "text", "Windsurf REST API error (401): nope")
    ]
    assert len(session.urls) == 1
    assert client._rest_url_probed is True
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_rest_probing_keeps_the_first_endpoint_that_answers(monkeypatch):
    client, session = _rest_client(
        [
            _Response(404, body="no chat here"),
            _choice("", [_call()], "tool_calls"),
            _choice("Done."),
        ],
        monkeypatch=monkeypatch,
    )

    messages = await _collect(client)

    assert _shape(messages)[-1] == ("assistant", "text", "Done.")
    assert session.urls == [
        "https://windsurf.com/api/v1/chat/completions",
        "https://api.codeium.com/v1/chat/completions",
        "https://api.codeium.com/v1/chat/completions",
    ]
    assert client._rest_base_url == "https://api.codeium.com/v1"
    assert client._rest_url_probed is True


@pytest.mark.asyncio
async def test_rest_no_endpoint_reachable(monkeypatch):
    client, session = _rest_client(
        [ConnectionError("refused")], monkeypatch=monkeypatch
    )

    messages = await _collect(client)

    assert _shape(messages) == [("system", "text", "Windsurf REST API error: refused")]
    assert len(session.urls) == 3


@pytest.mark.asyncio
async def test_rest_a_base_url_from_the_environment_is_the_only_one(monkeypatch):
    monkeypatch.setenv("WINDSURF_BASE_URL", "https://ws.example.test/v1")
    client = WindsurfAgentClient(model="gpt-4o")
    client._use_local_grpc = False
    session = _RestSession([_Response(502, body="bad gateway")])
    client._http_client = session

    messages = await _collect(client)

    assert session.urls == ["https://ws.example.test/v1/chat/completions"]
    assert _shape(messages) == [
        ("system", "text", "Windsurf REST API error (502): bad gateway")
    ]


@pytest.mark.asyncio
async def test_rest_stops_at_max_turns(monkeypatch):
    client, session = _rest_client(
        [_choice("", [_call()], "tool_calls")],
        max_turns=3,
        executor=_Executor(lambda n, *_: f"attempt {n}"),
        monkeypatch=monkeypatch,
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
    assert not any(NO_PROGRESS_STOP in (m.content[0].text or "") for m in messages)
    assert client.last_usage == {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


@pytest.mark.asyncio
async def test_rest_a_no_progress_stop_keeps_the_totals(monkeypatch):
    client, session = _rest_client(
        [
            _choice(
                "",
                [_call()],
                "tool_calls",
                usage={"prompt_tokens": 100, "completion_tokens": 1},
            )
        ],
        monkeypatch=monkeypatch,
    )

    messages = await _collect(client)

    assert _shape(messages)[-1] == ("system", "text", NO_PROGRESS_STOP)
    assert client.last_usage == {
        "input_tokens": 100 * len(session.payloads),
        "output_tokens": len(session.payloads),
        "cost_usd": 0.0,
    }


@pytest.mark.asyncio
async def test_rest_old_tool_results_are_cleared_past_the_budget(monkeypatch):
    monkeypatch.setenv("LLM_HISTORY_CHAR_BUDGET", "50000")
    client, session = _rest_client(
        [_choice("", [_call()], "tool_calls")],
        max_turns=8,
        executor=_Executor(lambda n, *_: f"{n}" + "z" * 12_000),
        monkeypatch=monkeypatch,
    )

    await _collect(client)

    # Results of ~10k chars cross the 50k budget after the fifth turn; with the
    # 8 latest messages kept, each later turn clears one more of the oldest.
    elided = [
        sum(m["content"] == ELIDED for m in payload["messages"] if m["role"] == "tool")
        for payload in session.payloads
    ]
    assert elided == [0, 0, 0, 0, 0, 1, 2, 3]
    last = session.payloads[-1]["messages"]
    assert [m["content"] for m in last if m["role"] == "tool"][3].startswith("4z")
    # The task itself is never cleared.
    assert last[1] == {"role": "user", "content": "fix it"}


@pytest.mark.asyncio
async def test_rest_a_resumed_history_comes_after_the_system_prompt(monkeypatch):
    client, session = _rest_client([_choice("Done.")], monkeypatch=monkeypatch)
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
async def test_rest_the_ledger_restarts_before_the_first_message(monkeypatch):
    usage = {"prompt_tokens": 10, "completion_tokens": 1}
    client, _session = _rest_client(
        [_choice("Done.", usage=usage)], monkeypatch=monkeypatch
    )
    await _collect(client)
    await client.query("again")

    async for _msg in client.receive_response():
        # The session runner prices the ledger after every message.
        assert client.usage_ledger.calls == [CallUsage(10, None, None, 1)]


@pytest.mark.asyncio
async def test_rest_a_null_tool_calls_field_raises(monkeypatch):
    """Pins a bug reported with lot 1b-ii: the turn's log line takes the
    length of ``tool_calls``, so an endpoint that sends ``null`` crashes the
    loop instead of ending the turn."""
    client, _session = _rest_client(
        [
            _Response(
                200, {"choices": [{"message": {"content": "hi", "tool_calls": None}}]}
            )
        ],
        monkeypatch=monkeypatch,
    )

    with pytest.raises(TypeError):
        await _collect(client)


# =============================================================================
# Text mode (gRPC through the local IDE)
# =============================================================================


class _Cascade:
    """Stands in for ``cascade_chat``: scripted answers, recorded requests."""

    def __init__(self, answers):
        self._answers = list(answers)
        self.requests: list[list[dict]] = []
        self.credentials: list[Any] = []

    async def __call__(self, *, credentials, messages, model_enum, model_uid):
        self.requests.append(json.loads(json.dumps(messages)))
        self.credentials.append(credentials)
        answer = self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]
        if callable(answer):
            answer = answer(len(self.requests))
        if isinstance(answer, Exception):
            raise answer
        return answer


def _tag(name="read_file", arguments=None) -> str:
    payload = {"name": name, "arguments": arguments or {"path": "a.py"}}
    return f"<tool_call>{json.dumps(payload)}</tool_call>"


@pytest.fixture
def cascade(monkeypatch):
    import integrations.windsurf_proxy.cascade_client as cascade_module
    import integrations.windsurf_proxy.models as models

    monkeypatch.setattr(models, "requires_cascade", lambda name: True)

    def install(answers):
        fake = _Cascade(answers)
        monkeypatch.setattr(cascade_module, "cascade_chat", fake)
        return fake

    return install


def _text_client(*, max_turns=50, executor=None, tools=True):
    client = WindsurfAgentClient(
        model="swe-1.6", system_prompt="be brief", max_turns=max_turns
    )
    client._use_local_grpc = True
    client._credentials = "creds-1"
    client._tool_definitions = [READ_FILE] if tools else []
    client._tool_executor = executor if executor is not None else _Executor()
    return client


@pytest.mark.asyncio
async def test_text_mode_a_final_answer_ends_the_response(cascade):
    fake = cascade(["All done."])
    client = _text_client()

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "All done.")]
    assert len(fake.requests) == 1
    assert fake.requests[0][1] == {"role": "user", "content": "fix it"}
    assert fake.credentials == ["creds-1"]
    # Text mode reports no usage: an empty ledger, no totals.
    assert client.usage_ledger.calls == []
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_text_mode_describes_the_tools_in_the_system_prompt(cascade):
    fake = cascade(["All done."])
    client = _text_client()

    await _collect(client)

    system = fake.requests[0][0]
    assert system["role"] == "system"
    assert system["content"].startswith("be brief\n\n## Available Tools")
    assert '{"name": "tool_name", "arguments": {"param": "value"}}' in system["content"]
    assert "**read_file** — Read a file" in system["content"]
    assert "  - `path` (string (required)): The path" in system["content"]


@pytest.mark.asyncio
async def test_text_mode_a_tool_turn_is_parsed_executed_and_sent_back(cascade):
    first = f"Let me look.\n{_tag()}\nthen more"
    fake = cascade([first, "Done."])
    executor = _Executor()
    client = _text_client(executor=executor)

    messages = await _collect(client)

    assert _shape(messages) == [
        ("assistant", "text", "Let me look.\n\nthen more"),
        ("assistant", "tool_use", "read_file", "grpc_0_0_read_file", {"path": "a.py"}),
        ("assistant", "tool_result", "grpc_0_0_read_file", False, "x = 1\n"),
        ("assistant", "text", "Done."),
    ]
    assert executor.calls == [("read_file", {"path": "a.py"})]
    # The answer goes back whole, tags included; the results as one user turn.
    assert fake.requests[1][2:] == [
        {"role": "assistant", "content": first},
        {
            "role": "user",
            "content": '<tool_result name="read_file" status="success">\nx = 1\n\n</tool_result>',
        },
    ]
    # Text mode keeps 8k chars of a result: the paging tools fit under it.
    assert executor.result_max_chars == 8000


@pytest.mark.asyncio
async def test_text_mode_several_calls_make_one_results_message(cascade):
    def results(n, name, args):
        return RuntimeError("boom") if name == "list_files" else "content"

    fake = cascade([_tag() + _tag("list_files", {"path": "."}), "Done."])
    client = _text_client(executor=_Executor(results))

    messages = await _collect(client)

    # Nothing but tags: no text message for the first answer.
    assert _shape(messages)[:4] == [
        ("assistant", "tool_use", "read_file", "grpc_0_0_read_file", {"path": "a.py"}),
        ("assistant", "tool_result", "grpc_0_0_read_file", False, "content"),
        ("assistant", "tool_use", "list_files", "grpc_0_1_list_files", {"path": "."}),
        ("assistant", "tool_result", "grpc_0_1_list_files", True, "Error: boom"),
    ]
    assert fake.requests[1][-1] == {
        "role": "user",
        "content": (
            '<tool_result name="read_file" status="success">\ncontent\n</tool_result>'
            "\n\n"
            '<tool_result name="list_files" status="error">\nError: boom\n</tool_result>'
        ),
    }


@pytest.mark.asyncio
async def test_text_mode_unreadable_tool_calls_are_skipped(cascade):
    fake = cascade(
        ['<tool_call>not json</tool_call><tool_call>{"arguments": {}}</tool_call>']
    )
    client = _text_client()

    messages = await _collect(client)

    # No call survives and no text is left: the turn ends as an empty answer.
    assert _shape(messages) == [("assistant", "text", "(No response from Windsurf)")]
    assert len(fake.requests) == 1


@pytest.mark.asyncio
async def test_text_mode_a_long_result_is_cut_at_8000(cascade):
    long = "a" * 9_000 + "b" * 9_000 + "VERDICT"
    fake = cascade([_tag(), "Done."])
    client = _text_client(executor=_Executor(lambda *_: long))

    messages = await _collect(client)

    assert _shape(messages)[1][4] == long
    assert fake.requests[1][-1]["content"] == (
        '<tool_result name="read_file" status="success">\n'
        f"{truncate_tool_result(long, limit=8000)}\n"
        "</tool_result>"
    )


@pytest.mark.asyncio
async def test_text_mode_an_empty_answer_ends_the_response(cascade):
    fake = cascade([""])
    client = _text_client()

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "(Empty response from Windsurf)")]
    assert len(fake.requests) == 1


@pytest.mark.asyncio
async def test_text_mode_an_error_ends_the_response(cascade):
    fake = cascade([RuntimeError("boom")])
    client = _text_client()

    messages = await _collect(client)

    assert _shape(messages) == [("system", "text", "Windsurf gRPC error: boom")]
    assert len(fake.requests) == 1


def _patch_refresh(monkeypatch) -> dict:
    import asyncio

    import integrations.windsurf_proxy.auth as auth
    import integrations.windsurf_proxy.grpc_client as grpc_client

    seen = {"discover": 0, "invalidate": 0, "sleeps": []}

    def discover():
        seen["discover"] += 1
        return "creds-2"

    def invalidate():
        seen["invalidate"] += 1

    async def sleep(seconds):
        seen["sleeps"].append(seconds)

    monkeypatch.setattr(auth, "discover_credentials", discover)
    monkeypatch.setattr(auth, "invalidate_process_cache", invalidate)
    monkeypatch.setattr(asyncio, "sleep", sleep)
    monkeypatch.setattr(grpc_client, "_panel_initialized", True)
    return seen


@pytest.mark.asyncio
async def test_text_mode_a_cascade_session_error_is_retried_once(cascade, monkeypatch):
    import integrations.windsurf_proxy.grpc_client as grpc_client

    seen = _patch_refresh(monkeypatch)
    fake = cascade(
        [RuntimeError("FAILED_PRECONDITION: Cascade session expired"), "Recovered."]
    )
    client = _text_client()

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "Recovered.")]
    assert fake.credentials == ["creds-1", "creds-2"]
    assert seen == {"discover": 1, "invalidate": 1, "sleeps": [1.5]}
    assert grpc_client._panel_initialized is False


@pytest.mark.asyncio
async def test_text_mode_a_session_error_sent_as_text_is_retried(cascade, monkeypatch):
    seen = _patch_refresh(monkeypatch)
    fake = cascade(["failed_precondition: cascade session error", "Recovered."])
    client = _text_client()

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "Recovered.")]
    assert len(fake.requests) == 2
    # Refreshed twice: once on reading the error, again on the retry itself.
    assert seen == {"discover": 2, "invalidate": 2, "sleeps": [1.5, 1.5]}
    assert fake.credentials == ["creds-1", "creds-2"]


@pytest.mark.asyncio
async def test_text_mode_a_session_error_that_cannot_refresh_reads_as_an_answer(
    cascade, monkeypatch
):
    """Pins a bug reported with lot 1b-ii: when the session error comes back
    as text and the credentials cannot be refreshed, the error text is
    yielded as the model's answer instead of an error."""
    import integrations.windsurf_proxy.auth as auth

    _patch_refresh(monkeypatch)

    def no_ide():
        raise RuntimeError("Windsurf is not running")

    monkeypatch.setattr(auth, "discover_credentials", no_ide)
    error_text = "failed_precondition: cascade session error"
    cascade([error_text])
    client = _text_client()

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", error_text)]


@pytest.mark.asyncio
async def test_text_mode_without_cascade_streams_the_answer(monkeypatch):
    import integrations.windsurf_proxy.grpc_client as grpc_client
    import integrations.windsurf_proxy.models as models

    calls: list[dict] = []

    async def stream_chat(
        *, credentials, messages, model_enum, model_name, system_prompt
    ):
        calls.append({"system_prompt": system_prompt, "messages": len(messages)})
        for chunk in ("Hel", "lo."):
            yield chunk

    monkeypatch.setattr(models, "requires_cascade", lambda name: False)
    monkeypatch.setattr(grpc_client, "stream_chat", stream_chat)
    client = _text_client()

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "Hello.")]
    assert calls[0]["system_prompt"].startswith("be brief\n\n## Available Tools")
    assert calls[0]["messages"] == 2


@pytest.mark.asyncio
async def test_text_mode_stops_at_max_turns(cascade):
    fake = cascade([_tag()])
    client = _text_client(max_turns=3, executor=_Executor(lambda n, *_: f"attempt {n}"))

    messages = await _collect(client)

    assert len(fake.requests) == 3
    assert _shape(messages)[-1] == (
        "assistant",
        "tool_result",
        "grpc_2_0_read_file",
        False,
        "attempt 3",
    )
    assert client.last_usage is None


@pytest.mark.asyncio
async def test_text_mode_old_tool_results_are_cleared_past_the_budget(
    cascade, monkeypatch
):
    monkeypatch.setenv("LLM_HISTORY_CHAR_BUDGET", "50000")
    fake = cascade([_tag()])
    client = _text_client(
        max_turns=8, executor=_Executor(lambda n, *_: f"{n}" + "z" * 12_000)
    )

    await _collect(client)

    # Text-mode results are user messages opening on <tool_result: cleared
    # like any tool result, here three in one batch once the budget is crossed.
    elided = [
        sum(m["content"] == ELIDED for m in request if m["role"] == "user")
        for request in fake.requests
    ]
    assert elided == [0, 0, 0, 0, 0, 0, 0, 3]
    last = fake.requests[-1]
    results = [m["content"] for m in last if m["role"] == "user"][1:]
    assert results[3].startswith('<tool_result name="read_file"')
    assert last[1] == {"role": "user", "content": "fix it"}


@pytest.mark.asyncio
async def test_text_mode_a_resumed_history_comes_after_the_system_prompt(cascade):
    fake = cascade(["All done."])
    client = _text_client()
    await client.resume(
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="earlier")],
            )
        ]
    )

    await _collect(client)

    assert [m["role"] for m in fake.requests[0]] == ["system", "system", "user"]
    assert "earlier" in fake.requests[0][1]["content"]


@pytest.mark.asyncio
async def test_text_mode_without_tools_is_a_single_request(cascade):
    fake = cascade([f"Answer {_tag()}"])
    client = _text_client(tools=False)

    messages = await _collect(client)

    # No tool loop: the answer comes back as it is, tags and all.
    assert _shape(messages) == [("assistant", "text", f"Answer {_tag()}")]
    assert len(fake.requests) == 1
    assert fake.requests[0][0] == {"role": "system", "content": "be brief"}
