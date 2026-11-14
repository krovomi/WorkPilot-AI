"""agents.tool_breaker: an agent that repeats the same call is paused, on any provider."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from agents.tool_breaker import (
    DEFAULT_LIMIT,
    LIMIT_ENV,
    PAUSE_REASON,
    ToolBreaker,
    configured_limit,
)
from core.agent_client import AgentMessage, ContentBlock, ContentBlockType, MessageRole
from foundation.pause_state import read_pause_state, task_spec_dirs
from task_logger import LogPhase


def _spec(tmp_path: Path) -> Path:
    spec = tmp_path / "proj" / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    return spec


def _repeat(breaker: ToolBreaker, times: int, result: str = "same") -> list[bool]:
    trips = []
    for index in range(times):
        breaker.call("Read", {"file_path": "a.py"}, f"c{index}")
        trips.append(breaker.result(result, False, f"c{index}"))
    return trips


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (None, DEFAULT_LIMIT),
        ("", DEFAULT_LIMIT),
        ("8", 8),
        ("0", 0),
        ("-3", 0),
        ("x", DEFAULT_LIMIT),
    ],
)
def test_configured_limit(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv(LIMIT_ENV, raising=False)
    else:
        monkeypatch.setenv(LIMIT_ENV, raw)
    assert configured_limit() == expected


def test_the_same_call_with_the_same_result_trips_once_at_the_limit(tmp_path):
    spec = _spec(tmp_path)
    breaker = ToolBreaker(spec, "coding", limit=3)

    assert _repeat(breaker, 5) == [False, False, True, False, False]
    state = read_pause_state(spec)
    assert state["enabled"] is True
    assert state["reason"] == PAUSE_REASON
    assert state["paused_phase"] == "coding"
    assert state["breaker"] == {"tool": "Read", "repeats": 3, "limit": 3}


def test_a_changing_result_is_progress(tmp_path):
    breaker = ToolBreaker(_spec(tmp_path), "coding", limit=3)
    for index in range(6):
        breaker.call("Bash", {"command": "pytest"}, None)
        assert breaker.result(f"{index} failed", False) is False
    assert not breaker.tripped


def test_a_file_written_starts_the_count_over(tmp_path):
    breaker = ToolBreaker(_spec(tmp_path), "coding", limit=3)
    assert _repeat(breaker, 2) == [False, False]
    breaker.call("mcp__workpilot__write_file", {"path": "a.py"}, "w")
    assert breaker.result("ok", False, "w") is False
    assert _repeat(breaker, 2) == [False, False]
    assert not breaker.tripped


def test_a_failed_write_is_not_progress(tmp_path):
    breaker = ToolBreaker(_spec(tmp_path), "coding", limit=3)
    assert _repeat(breaker, 2) == [False, False]
    breaker.call("Edit", {"file_path": "a.py"}, "w")
    breaker.result("old_string not found", True, "w")
    assert _repeat(breaker, 1) == [True]


def test_results_are_matched_to_their_calls(tmp_path):
    """Parallel calls answered out of order are still told apart."""
    breaker = ToolBreaker(_spec(tmp_path), "coding", limit=2)
    breaker.call("Read", {"file_path": "a.py"}, "a")
    breaker.call("Read", {"file_path": "b.py"}, "b")
    assert breaker.result("B", False, "b") is False
    assert breaker.result("A", False, "a") is False
    breaker.call("Read", {"file_path": "b.py"}, "b2")
    assert breaker.result("B", False, "b2") is True


def test_zero_switches_the_breaker_off(tmp_path):
    breaker = ToolBreaker(_spec(tmp_path), "coding", limit=0)
    assert _repeat(breaker, 10) == [False] * 10
    assert read_pause_state(breaker.spec_dir) == {}


def test_a_validation_session_pauses_the_qa_phase(tmp_path):
    breaker = ToolBreaker(_spec(tmp_path), LogPhase.VALIDATION.value, limit=1)
    _repeat(breaker, 1)
    assert read_pause_state(breaker.spec_dir)["paused_phase"] == "qa_review"


def test_a_worktree_build_pauses_the_main_copy_too(tmp_path):
    root = tmp_path / "proj"
    main = root / ".workpilot" / "specs" / "001-x"
    main.mkdir(parents=True)
    own = (
        root
        / ".workpilot"
        / "worktrees"
        / "tasks"
        / "001-x"
        / ".workpilot"
        / "specs"
        / "001-x"
    )
    own.mkdir(parents=True)

    assert task_spec_dirs(own) == [own, main]
    _repeat(ToolBreaker(own, "coding", limit=1), 1)
    assert read_pause_state(main)["reason"] == PAUSE_REASON
    assert read_pause_state(own)["reason"] == PAUSE_REASON


# --- the session runner ------------------------------------------------------


class _LoopingClient:
    """Calls the same tool and gets the same answer, forever."""

    enforces_own_budget = True

    def __init__(self) -> None:
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
        for index in range(50):
            self.turns += 1
            yield AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_USE,
                        tool_name="run_command",
                        tool_id=f"t{index}",
                        tool_input={"command": "ls"},
                    )
                ],
            )
            yield AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_RESULT,
                        tool_use_id=f"t{index}",
                        result_content="a.py\nb.py",
                    )
                ],
            )


@pytest.mark.asyncio
async def test_the_session_ends_and_the_task_is_paused(tmp_path, monkeypatch):
    from agents.session import _run_agent_client_session

    monkeypatch.delenv(LIMIT_ENV, raising=False)
    spec = _spec(tmp_path)
    (spec / "task_metadata.json").write_text(
        json.dumps({"taskId": "t1"}), encoding="utf-8"
    )
    client = _LoopingClient()

    await _run_agent_client_session(client, "code it", spec, phase=LogPhase.CODING)

    assert client.turns == DEFAULT_LIMIT
    state = read_pause_state(spec)
    assert state["reason"] == PAUSE_REASON
    assert state["breaker"]["tool"] == "run_command"
