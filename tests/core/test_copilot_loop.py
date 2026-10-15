"""The Copilot loop: what its other tests leave out (harness lot 1b-ii).

``tests/test_agent_client.py`` and ``tests/test_copilot_integration.py`` pin
the retries, the model fallback and the write nudges. These pin the rest
before the loop moves into the shared one: the request and its headers, what
goes back to the model, the GitHub Models fallback, a retry that spends a
turn, and the totals. No network.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest
from core.agent_client import ContentBlockType, CopilotAgentClient
from core.llm_optimization import truncate_tool_result
from harness.domain import CallUsage

ELIDED = "[tool result elided to save context — re-run the tool if needed]"
COPILOT_URL = "https://api.githubcopilot.com/chat/completions"
MODELS_URL = "https://models.inference.ai.azure.com/chat/completions"
ZERO_USAGE = {"input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0}


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
        self.headers: dict = {}
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
        self.auth: list[str] = []
        self.headers: list[dict] = []

    def post(self, url, json=None, headers=None):  # noqa: A002 - aiohttp's name
        self.urls.append(url)
        self.payloads.append(_copy(json))
        self.headers.append(dict(headers))
        self.auth.append(headers["Authorization"])
        return self._answers.pop(0) if len(self._answers) > 1 else self._answers[0]


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
    return {"id": call_id, "function": {"name": name, "arguments": args}}


def _shape(messages) -> list[tuple]:
    shape = []
    for msg in messages:
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


def _client(answers, *, max_turns=50, executor=None):
    client = CopilotAgentClient(
        github_token="ghp_test", system_prompt="be brief", max_turns=max_turns
    )
    client._tool_definitions = [{"name": "read_file", "parameters": {}}]
    client._tool_executor = executor if executor is not None else _Executor()
    client._get_copilot_token = AsyncMock(return_value="copilot-token")
    session = _Session(answers)
    client._http_client = session
    return client, session


async def _collect(client, prompt: str = "fix it"):
    await client.query(prompt)
    return [msg async for msg in client.receive_response()]


@pytest.mark.asyncio
async def test_a_tool_turn_is_yielded_executed_and_sent_back():
    tool_calls = [_call(call_id="call_7")]
    long = "a" * 9_000 + "b" * 9_000 + "VERDICT"
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
        executor=_Executor(lambda *_: long),
    )

    messages = await _collect(client)

    assert _shape(messages) == [
        ("assistant", "text", "Reading."),
        ("assistant", "tool_use", "read_file", "call_7", {"path": "a.py"}),
        ("assistant", "tool_result", "call_7", False, long),
        ("assistant", "text", "Done."),
    ]
    assert session.urls == [COPILOT_URL, COPILOT_URL]
    assert session.headers[0] == {
        "Authorization": "Bearer copilot-token",
        "Copilot-Integration-Id": "vscode-chat",
        "openai-intent": "conversation-panel",
        "x-github-api-version": "2025-04-01",
    }
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
                "function": {"name": "read_file", "description": "", "parameters": {}},
            }
        ],
        "tool_choice": "auto",
    }
    assert session.payloads[1]["messages"][2:] == [
        {"role": "assistant", "content": "Reading.", "tool_calls": tool_calls},
        {
            "role": "tool",
            "tool_call_id": "call_7",
            "content": truncate_tool_result(long),
        },
    ]
    # Every reported call is measured; the totals stay the subscription's zeros.
    assert client.usage_ledger.calls == [
        CallUsage(1_000, None, None, 10),
        CallUsage(1_500, None, None, 20),
    ]
    assert client.last_usage == ZERO_USAGE
    assert client.last_context_tokens == 1_500


@pytest.mark.asyncio
async def test_a_failing_tool_and_a_missing_executor():
    client, session = _client(
        [
            _choice("", [_call(), _call("list_files", "{}", "call_2")], "tool_calls"),
            _choice("Done."),
        ],
        executor=_Executor(lambda n, *_: RuntimeError("boom") if n == 1 else "ok"),
    )

    messages = await _collect(client)

    assert _shape(messages)[1] == (
        "assistant",
        "tool_result",
        "call_1",
        True,
        "Tool error: boom",
    )
    assert _shape(messages)[3] == ("assistant", "tool_result", "call_2", False, "ok")

    client, _session = _client([_choice("", [_call()], "tool_calls"), _choice("Done.")])
    client._tool_executor = None
    messages = await _collect(client)
    assert _shape(messages)[1][3:] == (True, "Tool executor not available")


@pytest.mark.asyncio
async def test_mcp_tools_are_not_routed_on_copilot():
    """Copilot executes every call through the tool executor, even a name an
    MCP manager would answer."""

    class _Mcp:
        def has_tool(self, name):
            return True

        async def call(self, name, args):  # pragma: no cover - must not run
            raise AssertionError("Copilot does not route MCP tools")

    executor = _Executor()
    client, _session = _client(
        [
            _choice("", [_call("hf_search", "{}", "call_m")], "tool_calls"),
            _choice("Done."),
        ],
        executor=executor,
    )
    client._mcp_manager = _Mcp()

    await _collect(client)

    assert executor.calls == [("hf_search", {})]


@pytest.mark.asyncio
async def test_a_token_refresh_failure_ends_before_any_request():
    client, session = _client([_choice("Done.")])
    client._get_copilot_token = AsyncMock(side_effect=RuntimeError("no token"))

    messages = await _collect(client)

    assert _shape(messages) == [("system", "text", "Copilot auth error: no token")]
    assert session.payloads == []
    assert client.last_usage == ZERO_USAGE


@pytest.mark.asyncio
async def test_a_403_falls_back_to_github_models_for_the_rest_of_the_response():
    client, session = _client(
        [
            _Response(403, body="blocked by org"),
            _choice(
                "",
                [_call()],
                "tool_calls",
                usage={"prompt_tokens": 70, "completion_tokens": 7},
            ),
            _choice("Done.", usage={"prompt_tokens": 90, "completion_tokens": 9}),
        ]
    )

    messages = await _collect(client)

    assert _shape(messages)[-1] == ("assistant", "text", "Done.")
    assert session.urls == [COPILOT_URL, MODELS_URL, MODELS_URL]
    assert session.auth == [
        "Bearer copilot-token",
        "Bearer ghp_test",
        "Bearer ghp_test",
    ]
    assert client._using_github_models is True
    # Pins a gap reported with lot 1b-ii: the call answered by the fallback
    # request is not measured; the later ones are.
    assert client.usage_ledger.calls == [CallUsage(90, None, None, 9)]


@pytest.mark.asyncio
async def test_a_failing_github_models_fallback_ends_the_response():
    client, _session = _client(
        [_Response(403, body="blocked"), _Response(401, body="bad token")]
    )

    messages = await _collect(client)

    assert _shape(messages) == [
        ("system", "text", "GitHub Models API error (401): bad token")
    ]


@pytest.mark.asyncio
async def test_another_400_ends_the_response():
    client, session = _client([_Response(400, body="malformed")])

    messages = await _collect(client)

    assert _shape(messages) == [
        ("system", "text", "Copilot API error (400): malformed")
    ]
    assert len(session.payloads) == 1


@pytest.mark.asyncio
async def test_a_retried_empty_response_spends_a_turn(monkeypatch):
    import core.agent_clients.copilot as copilot

    monkeypatch.setattr(copilot, "_COPILOT_EMPTY_RESPONSE_BACKOFF", 0.0)
    client, session = _client([_Response(200, {"choices": []})], max_turns=2)

    messages = await _collect(client)

    # Two turns, two empty answers: max_turns ends it before the empty cap.
    assert len(session.payloads) == 2
    assert messages == []
    assert client.last_usage == ZERO_USAGE


@pytest.mark.asyncio
async def test_an_announced_but_missing_tool_call_is_asked_for_again():
    client, session = _client(
        [_choice("thinking...", [], "tool_calls"), _choice("Done.")]
    )

    messages = await _collect(client)

    assert _shape(messages) == [
        ("assistant", "text", "thinking..."),
        ("assistant", "text", "Done."),
    ]
    assert session.payloads[1]["messages"][2:] == [
        {"role": "assistant", "content": "thinking..."},
        {
            "role": "user",
            "content": "Please proceed by calling the appropriate tools to complete your task.",
        },
    ]


@pytest.mark.asyncio
async def test_a_reply_with_nothing_in_it():
    client, _session = _client([_choice(None)])

    messages = await _collect(client)

    assert _shape(messages) == [("assistant", "text", "(No response from Copilot)")]


@pytest.mark.asyncio
async def test_max_turns_ends_the_response():
    client, session = _client(
        [_choice("", [_call()], "tool_calls")],
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
    assert client.last_usage == ZERO_USAGE


@pytest.mark.asyncio
async def test_old_tool_results_are_cleared_past_the_budget(monkeypatch):
    monkeypatch.setenv("LLM_HISTORY_CHAR_BUDGET", "50000")
    client, session = _client(
        [_choice("", [_call()], "tool_calls")],
        max_turns=8,
        executor=_Executor(lambda n, *_: f"{n}" + "z" * 12_000),
    )

    await _collect(client)

    elided = [
        sum(
            m.get("content") == ELIDED
            for m in payload["messages"]
            if m["role"] == "tool"
        )
        for payload in session.payloads
    ]
    assert elided == [0, 0, 0, 0, 0, 1, 2, 3]


@pytest.mark.asyncio
async def test_the_ledger_restarts_before_the_first_message():
    usage = {"prompt_tokens": 10, "completion_tokens": 1}
    client, _session = _client([_choice("Done.", usage=usage)])
    await _collect(client)
    await client.query("again")

    async for _ in client.receive_response():
        assert client.usage_ledger.calls == [CallUsage(10, None, None, 1)]


@pytest.mark.asyncio
async def test_a_null_tool_calls_field_raises():
    """Pins a bug reported with lot 1b-ii (see ``test_openai_loop``)."""
    client, _session = _client(
        [
            _Response(
                200, {"choices": [{"message": {"content": "hi", "tool_calls": None}}]}
            )
        ]
    )

    with pytest.raises(TypeError):
        await _collect(client)
