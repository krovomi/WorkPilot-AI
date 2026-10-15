"""Each client records its model calls in the harness's common unit.

The CLI clients are covered next to their own tests (Codex, OpenCode,
Antigravity); here are the Claude SDK wrapper and the WorkPilot HTTP loops.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from core.agent_client import ClaudeAgentClient, CopilotAgentClient, OpenAIAgentClient
from harness.domain import CallUsage


class AssistantMessage:
    """Stands in for the SDK type; the client dispatches on the class name."""

    def __init__(self, message_id, usage, parent_tool_use_id=None):
        self.content = []
        self.structured_output = None
        self.message_id = message_id
        self.usage = usage
        self.parent_tool_use_id = parent_tool_use_id


def _usage(uncached: int, read: int, write: int, output: int) -> dict:
    return {
        "input_tokens": uncached,
        "cache_read_input_tokens": read,
        "cache_creation_input_tokens": write,
        "output_tokens": output,
    }


async def _drain(client) -> None:
    async for _ in client.receive_response():
        pass


@pytest.mark.asyncio
async def test_claude_counts_a_call_once_and_keeps_subagents_apart():
    first = _usage(10, 0, 20_000, 300)
    second = _usage(10, 20_000, 400, 300)
    sub = _usage(5, 0, 3_000, 100)
    messages = [
        # The CLI sends one AssistantMessage per content block of a call.
        AssistantMessage("msg_1", first),
        AssistantMessage("msg_1", first),
        AssistantMessage("msg_sub", sub, parent_tool_use_id="toolu_task"),
        AssistantMessage("msg_2", second),
    ]

    async def receive():
        for message in messages:
            yield message

    sdk = MagicMock()
    sdk.receive_response = receive
    client = ClaudeAgentClient(sdk)
    await _drain(client)

    ledger = client.usage_ledger
    assert ledger.calls == [
        CallUsage(20_010, 0, 20_000, 300),
        CallUsage(3_005, 0, 3_000, 100),
        CallUsage(20_410, 20_000, 400, 300),
    ]
    # The sub-agent's cold start is not a rewrite of the main thread's prefix.
    assert ledger.prefix_rewrites == 0


class SystemMessage:
    def __init__(self, subtype):
        self.subtype = subtype
        self.data = {}


@pytest.mark.asyncio
async def test_native_compaction_is_not_a_prefix_rewrite():
    messages = [
        AssistantMessage("msg_1", _usage(10, 0, 150_000, 300)),
        SystemMessage("compact_boundary"),
        # The compacted thread is short and cold: expected, not a rewrite.
        AssistantMessage("msg_2", _usage(10, 0, 8_000, 300)),
    ]

    async def receive():
        for message in messages:
            yield message

    sdk = MagicMock()
    sdk.receive_response = receive
    client = ClaudeAgentClient(sdk)
    await _drain(client)
    assert client.usage_ledger.prefix_rewrites == 0


@pytest.mark.asyncio
async def test_claude_ledger_restarts_with_each_response():
    async def receive():
        yield AssistantMessage("msg_1", _usage(10, 0, 2_000, 30))

    sdk = MagicMock()
    sdk.receive_response = receive
    client = ClaudeAgentClient(sdk)
    await _drain(client)
    await _drain(client)
    assert len(client.usage_ledger.calls) == 1


def _http_session(payload: dict) -> MagicMock:
    response = MagicMock()
    response.status = 200
    response.json = AsyncMock(return_value=payload)
    response.__aenter__ = AsyncMock(return_value=response)
    response.__aexit__ = AsyncMock(return_value=None)
    session = MagicMock()
    session.post = MagicMock(return_value=response)
    return session


_FINAL_CHOICE = [{"message": {"content": "Done.", "tool_calls": []}}]


@pytest.mark.asyncio
async def test_openai_compatible_loop_reads_the_cached_part():
    client = OpenAIAgentClient(api_key="sk-test-0000")
    client._http_client = _http_session(
        {
            "choices": _FINAL_CHOICE,
            "usage": {
                "prompt_tokens": 2_000,
                "completion_tokens": 30,
                "prompt_tokens_details": {"cached_tokens": 1_536},
            },
        }
    )
    await client.query("hello")
    await _drain(client)

    assert client.usage_ledger.calls == [CallUsage(2_000, 1_536, None, 30)]
    assert client.usage_ledger.cache_hit_ratio() == pytest.approx(1_536 / 2_000)


@pytest.mark.asyncio
async def test_a_provider_without_cache_fields_has_no_hit_ratio():
    client = CopilotAgentClient(github_token="ghp_test")
    client._http_client = _http_session(
        {
            "choices": _FINAL_CHOICE,
            "usage": {"prompt_tokens": 1_200, "completion_tokens": 40},
        }
    )
    await client.query("hello")
    with patch.object(client, "_get_copilot_token", return_value="mock_token"):
        await _drain(client)

    assert client.usage_ledger.calls == [CallUsage(1_200, None, None, 40)]
    assert client.usage_ledger.cache_hit_ratio() is None


@pytest.mark.asyncio
async def test_a_response_without_usage_records_nothing():
    client = CopilotAgentClient(github_token="ghp_test")
    client._http_client = _http_session({"choices": _FINAL_CHOICE})
    await client.query("hello")
    with patch.object(client, "_get_copilot_token", return_value="mock_token"):
        await _drain(client)

    assert client.usage_ledger.calls == []
