"""Where the ledger is read: the usage tracker's session fields and the gauge."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from agents.session import session_usage_fields
from context_mgmt.sdk_usage import SdkUsageProbe
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from harness.domain import CallUsage, UsageLedger
from task_logger import LogPhase


class _Client:
    def __init__(self, last_usage=None, calls=()):
        self.last_usage = last_usage
        self.usage_ledger = None
        if calls:
            self.usage_ledger = UsageLedger()
            for call in calls:
                self.usage_ledger.record(call)


def test_tracker_input_is_the_uncached_part_whatever_the_client_reported():
    # OpenCode's last_usage puts the whole prompt in input_tokens and the cache
    # beside it: summed by the tracker, the cache was counted twice.
    client = _Client(
        last_usage={
            "input_tokens": 4_200,
            "output_tokens": 30,
            "cache_read_input_tokens": 4_000,
            "cache_creation_input_tokens": 80,
        },
        calls=[CallUsage(4_200, 4_000, 80, 30)],
    )
    assert session_usage_fields(client) == {
        "input_tokens": 120,
        "output_tokens": 30,
        "cache_creation_input_tokens": 80,
        "cache_read_input_tokens": 4_000,
    }


def test_output_comes_from_the_session_total_when_there_is_one():
    # A streamed call's own usage can predate its last tokens.
    client = _Client(
        last_usage={"input_tokens": 10, "output_tokens": 900},
        calls=[CallUsage(20_010, 20_000, 0, 1)],
    )
    assert session_usage_fields(client)["output_tokens"] == 900


def test_without_a_ledger_the_client_report_is_used_as_before():
    client = _Client(last_usage={"input_tokens": 50, "output_tokens": 5})
    assert session_usage_fields(client) == {
        "input_tokens": 50,
        "output_tokens": 5,
        "cache_creation_input_tokens": 0,
        "cache_read_input_tokens": 0,
    }


def test_nothing_reported_records_nothing():
    assert session_usage_fields(_Client()) is None


class AssistantMessage:  # named like the SDK's: the probe dispatches on it
    def __init__(self, message_id: str, usage: dict) -> None:
        self.message_id = message_id
        self.usage = usage
        self.parent_tool_use_id = None


def test_the_raw_sdk_probe_counts_each_call_once():
    probe = SdkUsageProbe()
    usage = {
        "input_tokens": 10,
        "cache_read_input_tokens": 9_000,
        "cache_creation_input_tokens": 100,
        "output_tokens": 4,
    }
    probe.update(AssistantMessage("msg_1", usage))
    probe.update(AssistantMessage("msg_1", usage))
    assert probe.usage_ledger.calls == [CallUsage(9_110, 9_000, 100, 4)]
    assert probe.last_context_tokens == 9_110


class _LedgerClient:
    """A client whose ledger already holds the session's calls."""

    def __init__(self, calls: list[CallUsage]) -> None:
        self.model = "some-model"
        self.last_usage = None
        self.last_context_tokens = 2_000
        self.context_window_tokens = 100_000
        self.usage_ledger = UsageLedger()
        for call in calls:
            self.usage_ledger.record(call)

    def provider_name(self) -> str:
        return "deepseek"

    def resumes_native_session(self) -> bool:
        return False

    async def resume(self, history) -> None:  # noqa: ARG002
        return None

    async def query(self, prompt: str) -> None:  # noqa: ARG002
        return None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        yield AgentMessage(
            role=MessageRole.ASSISTANT,
            content=[ContentBlock(type=ContentBlockType.TEXT, text="done")],
        )


def _spec(tmp_path: Path) -> Path:
    spec = tmp_path / "proj" / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    meta = {"taskId": "t1", "contextPolicy": {}}
    (spec / "task_metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return spec


def _usage_events(out: str) -> list[dict]:
    events = (
        json.loads(line.split(":", 1)[1])
        for line in out.splitlines()
        if line.startswith("__TASK_EVENT__:")
    )
    return [event for event in events if event["type"] == "CONTEXT_USAGE"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("calls", "ratio"),
    [
        ([CallUsage(2_000, 1_800, None, 10)], 0.9),
        # A provider that reports no cache: unknown, not 0.
        ([CallUsage(2_000, None, None, 10)], None),
    ],
)
async def test_the_gauge_event_carries_the_cache_figures(
    tmp_path: Path, capsys, calls, ratio
):
    from agents.session import _run_agent_client_session

    spec = _spec(tmp_path)
    await _run_agent_client_session(
        _LedgerClient(calls),
        "code it",
        spec,
        phase=LogPhase.CODING,
        context_managed=True,
    )

    usage = _usage_events(capsys.readouterr().out)
    assert usage
    assert usage[-1]["cacheHitRatio"] == ratio
    assert usage[-1]["prefixRewrites"] == 0
