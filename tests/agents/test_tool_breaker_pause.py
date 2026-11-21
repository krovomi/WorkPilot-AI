"""A pause written while a session runs ends it after the call in flight, on any provider.

The voice assistant's spoken « stop » (issue #385) writes ``pause_state.json``
without killing the agent's process; ``agents.tool_breaker`` reads it after each
tool result, so the call in flight finishes and the next one never starts.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from agents.tool_breaker import LIMIT_ENV, ToolBreaker
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from foundation.pause_state import read_pause_state, write_pause_state
from task_logger import LogPhase

VOICE_STOP = "voice_stop"


def _spec(tmp_path: Path) -> Path:
    spec = tmp_path / "proj" / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    return spec


def _person_says_stop(spec: Path) -> None:
    """What the main writes for the spoken stop (`stop-after-step-handlers.ts`)."""
    write_pause_state(spec, phase="coding", reason=VOICE_STOP)


def test_a_result_after_the_pause_ends_the_session_once(tmp_path):
    spec = _spec(tmp_path)
    breaker = ToolBreaker(spec, "coding")
    breaker.call("Read", {"file_path": "a.py"}, "c1")
    assert breaker.result("one", False, "c1") is False

    _person_says_stop(spec)
    breaker.call("Read", {"file_path": "b.py"}, "c2")
    assert breaker.result("two", False, "c2") is True
    assert breaker.tripped
    assert breaker.pause_requested

    breaker.call("Read", {"file_path": "c.py"}, "c3")
    assert breaker.result("three", False, "c3") is False
    # The person's pause is kept as written: no loop record over it.
    state = read_pause_state(spec)
    assert state["reason"] == VOICE_STOP
    assert "breaker" not in state


def test_the_pause_holds_with_the_breaker_switched_off(tmp_path):
    spec = _spec(tmp_path)
    breaker = ToolBreaker(spec, "coding", limit=0)
    _person_says_stop(spec)
    assert breaker.result("orphan", False, "nobody") is True
    assert breaker.pause_requested


def test_a_loop_pause_is_not_a_requested_one(tmp_path):
    breaker = ToolBreaker(_spec(tmp_path), "coding", limit=1)
    breaker.call("Read", {"file_path": "a.py"}, "c1")
    assert breaker.result("same", False, "c1") is True
    assert not breaker.pause_requested


class _BusyClient:
    """An agent that calls a tool on each turn; the person says stop on turn 2."""

    enforces_own_budget = True

    def __init__(self, spec: Path) -> None:
        self.spec = spec
        self.model = "some-model"
        self.last_usage = None
        self.last_context_tokens = None
        self.context_window_tokens = 1_000_000
        self.turns = 0

    def provider_name(self) -> str:
        return "ollama"

    def resumes_native_session(self) -> bool:
        return False

    async def resume(self, history) -> None:  # noqa: ARG002
        return None

    async def query(self, prompt: str) -> None:  # noqa: ARG002
        return None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for index in range(10):
            self.turns += 1
            yield AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_USE,
                        tool_name="run_command",
                        tool_id=f"t{index}",
                        tool_input={"command": f"step {index}"},
                    )
                ],
            )
            if index == 1:
                _person_says_stop(self.spec)
            yield AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_RESULT,
                        tool_use_id=f"t{index}",
                        result_content=f"done {index}",
                    )
                ],
            )


@pytest.mark.asyncio
async def test_an_agent_client_session_stops_after_the_call_in_flight(
    tmp_path, monkeypatch
):
    from agents.session import _run_agent_client_session

    monkeypatch.delenv(LIMIT_ENV, raising=False)
    spec = _spec(tmp_path)
    (spec / "task_metadata.json").write_text(
        json.dumps({"taskId": "t1"}), encoding="utf-8"
    )
    client = _BusyClient(spec)

    await _run_agent_client_session(client, "code it", spec, phase=LogPhase.CODING)

    # Turn 2's call got its result; turn 3 never started.
    assert client.turns == 2
    assert read_pause_state(spec)["reason"] == VOICE_STOP


# The raw Claude SDK stream: messages told apart by their class name.


class ToolUseBlock:
    def __init__(self, index: int) -> None:
        self.name = "Bash"
        self.id = f"t{index}"
        self.input = {"command": f"step {index}"}


class ToolResultBlock:
    def __init__(self, index: int) -> None:
        self.tool_use_id = f"t{index}"
        self.content = f"done {index}"
        self.is_error = False


class AssistantMessage:
    def __init__(self, index: int) -> None:
        self.content = [ToolUseBlock(index)]


class UserMessage:
    def __init__(self, index: int) -> None:
        self.content = [ToolResultBlock(index)]


class _BusySdkClient:
    def __init__(self, spec: Path) -> None:
        self.spec = spec
        self.turns = 0

    async def query(self, prompt: str) -> None:  # noqa: ARG002
        return None

    async def receive_response(self):
        for index in range(10):
            self.turns += 1
            yield AssistantMessage(index)
            if index == 1:
                _person_says_stop(self.spec)
            yield UserMessage(index)


@pytest.mark.asyncio
async def test_a_claude_sdk_session_stops_after_the_call_in_flight(
    tmp_path, monkeypatch
):
    from agents.session import run_agent_session

    monkeypatch.delenv(LIMIT_ENV, raising=False)
    spec = _spec(tmp_path)
    client = _BusySdkClient(spec)

    await run_agent_session(client, "code it", spec, phase=LogPhase.CODING)

    assert client.turns == 2
    assert read_pause_state(spec)["reason"] == VOICE_STOP
