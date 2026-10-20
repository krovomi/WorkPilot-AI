"""Integration test: the provider-agnostic session loop breaks mid-stream when a
hot-swap marker targeting the running phase is present, and returns "hot_swap".

This exercises the actual `_run_agent_client_session` wiring (not just the pure
decision helper) with a minimal fake AgentClient, so a regression that stops the
loop from honouring the marker is caught.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from task_logger import LogPhase


class _FakeClient:
    """Bare AgentClient stand-in: yields a fixed set of assistant messages."""

    def __init__(self, provider: str, model: str, messages: list[AgentMessage]):
        self._provider = provider
        self.model = model
        self._messages = messages
        self.last_session_id: str | None = None
        self.last_usage: dict | None = None

    def provider_name(self) -> str:
        return self._provider

    async def query(self, prompt: str) -> None:  # noqa: ARG002 - fake
        return None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for m in self._messages:
            yield m


def _assistant_text(text: str) -> AgentMessage:
    return AgentMessage(
        role=MessageRole.ASSISTANT,
        content=[ContentBlock(type=ContentBlockType.TEXT, text=text)],
    )


@pytest.mark.asyncio
async def test_session_breaks_and_returns_hot_swap(tmp_path: Path) -> None:
    from agents.hot_swap import write_hot_swap_marker
    from agents.session import _run_agent_client_session

    # A pending swap for the running (planning) phase to a DIFFERENT model.
    write_hot_swap_marker(
        tmp_path, "planning", provider="anthropic", model="claude-sonnet-4-5"
    )

    client = _FakeClient(
        "anthropic",
        "claude-opus-4-6",  # current model differs from the marker's
        [_assistant_text("thinking about the plan"), _assistant_text("more")],
    )

    status, _response, info = await _run_agent_client_session(
        client, "plan the work", tmp_path, verbose=False, phase=LogPhase.PLANNING
    )

    assert status == "hot_swap"
    assert info.get("hot_swap") is True
    # The marker is left for the caller (coder/planner) to consume + apply.
    assert (tmp_path / "HOT_SWAP.json").exists()


@pytest.mark.asyncio
async def test_session_ignores_marker_for_other_phase(tmp_path: Path) -> None:
    from agents.hot_swap import write_hot_swap_marker
    from agents.session import _run_agent_client_session

    # Marker targets QA, but we run PLANNING → must NOT break on it.
    write_hot_swap_marker(tmp_path, "qa", model="claude-sonnet-4-5")

    client = _FakeClient("anthropic", "claude-opus-4-6", [_assistant_text("hi")])
    status, _response, _info = await _run_agent_client_session(
        client, "plan", tmp_path, verbose=False, phase=LogPhase.PLANNING
    )

    assert status != "hot_swap"  # normal completion ("continue")


@pytest.mark.asyncio
async def test_session_no_marker_is_normal(tmp_path: Path) -> None:
    from agents.session import _run_agent_client_session

    client = _FakeClient("anthropic", "claude-opus-4-6", [_assistant_text("hi")])
    status, _response, _info = await _run_agent_client_session(
        client, "plan", tmp_path, verbose=False, phase=LogPhase.PLANNING
    )

    assert status != "hot_swap"


@pytest.mark.asyncio
async def test_session_halts_on_unavailable_model(tmp_path: Path) -> None:
    """An invalid/inaccessible model (e.g. after a hot-swap to claude-haiku-4-6)
    must be reclassified as a halting error, not a silent 'continue' — otherwise
    the phase loops and then advances with nothing done."""
    from agents.session import _run_agent_client_session

    client = _FakeClient(
        "anthropic",
        "claude-haiku-4-6",
        [
            _assistant_text(
                "There's an issue with the selected model (claude-haiku-4-6). "
                "It may not exist or you may not have access to it."
            )
        ],
    )
    status, _response, info = await _run_agent_client_session(
        client, "code it", tmp_path, verbose=False, phase=LogPhase.CODING
    )

    assert status == "error"
    assert info.get("type") == "model_unavailable"
