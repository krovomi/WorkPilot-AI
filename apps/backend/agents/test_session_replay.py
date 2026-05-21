"""Tests for the conversation-replay wire-up in agents/session.py.

Covers the two helpers that the agent session calls at startup to feed any
prior conversation back into the (possibly new) provider:

- `_maybe_replay_conversation` — deserialise conversation.jsonl, call resume()
- `_maybe_inject_pending_tool_use_note` — prepend a directive if the last
  assistant turn was an un-dispatched tool_use
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from core.conversation_log import CONVERSATION_LOG_FILENAME, append_message


def _write_history(spec_dir: Path, messages: list[AgentMessage]) -> None:
    """Persist a fake conversation by reusing the real append_message()."""
    for m in messages:
        append_message(spec_dir, m, phase="coding", provider="claude", model="opus-4-7")


@pytest.mark.asyncio
async def test_replay_noop_when_no_log_exists(tmp_path: Path) -> None:
    """No conversation.jsonl — resume() must NOT be called at all (avoids
    cost of an empty preamble round-trip)."""
    from agents.session import _maybe_replay_conversation

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")
    fake_client.resume.assert_not_called()


@pytest.mark.asyncio
async def test_replay_deserializes_log_and_calls_resume(tmp_path: Path) -> None:
    """When the log has entries they should be deserialised and passed to
    resume() in order."""
    from agents.session import _maybe_replay_conversation

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="task A")],
            ),
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="working on it")
                ],
            ),
        ],
    )

    fake_client = AsyncMock()
    await _maybe_replay_conversation(fake_client, tmp_path, "copilot", "gpt-4o")

    fake_client.resume.assert_awaited_once()
    history_arg = fake_client.resume.await_args.args[0]
    assert len(history_arg) == 2
    assert history_arg[0].role == MessageRole.USER
    assert history_arg[0].content[0].text == "task A"
    assert history_arg[1].role == MessageRole.ASSISTANT


@pytest.mark.asyncio
async def test_replay_swallows_corrupt_log_silently(tmp_path: Path) -> None:
    """A garbage conversation.jsonl must NEVER take down session start —
    just log a warning and fall through with an empty history."""
    from agents.session import _maybe_replay_conversation

    (tmp_path / CONVERSATION_LOG_FILENAME).write_text(
        "{not valid json\n", encoding="utf-8"
    )

    fake_client = AsyncMock()
    # Should not raise.
    await _maybe_replay_conversation(fake_client, tmp_path, "claude", "opus")
    # read_log returns [] on malformed lines, so resume() isn't even called.
    fake_client.resume.assert_not_called()


def test_inject_pending_tool_use_note_prepends_directive(tmp_path: Path) -> None:
    """Last assistant message ended on a tool_use with no matching tool_result
    → the next user message must be prefixed with a directive."""
    from agents.session import _maybe_inject_pending_tool_use_note

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(type=ContentBlockType.TEXT, text="please read foo.py")
                ],
            ),
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_USE,
                        tool_name="Read",
                        tool_input={"file_path": "foo.py"},
                        tool_id="t1",
                    )
                ],
            ),
        ],
    )

    out = _maybe_inject_pending_tool_use_note("now please write a summary", tmp_path)
    assert out.startswith("[Resume directive]")
    assert "now please write a summary" in out


def test_inject_pending_tool_use_noop_when_no_pending(tmp_path: Path) -> None:
    """When the last assistant turn is plain text (no pending tool_use), the
    message must pass through unchanged."""
    from agents.session import _maybe_inject_pending_tool_use_note

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[ContentBlock(type=ContentBlockType.TEXT, text="done")],
            ),
        ],
    )

    out = _maybe_inject_pending_tool_use_note("next task", tmp_path)
    assert out == "next task"


def test_inject_pending_tool_use_noop_when_no_log(tmp_path: Path) -> None:
    """No log at all → unchanged message (fresh task)."""
    from agents.session import _maybe_inject_pending_tool_use_note

    out = _maybe_inject_pending_tool_use_note("hello", tmp_path)
    assert out == "hello"


def test_inject_pending_tool_use_handles_corrupt_log(tmp_path: Path) -> None:
    """Corrupt log must not crash session startup."""
    from agents.session import _maybe_inject_pending_tool_use_note

    (tmp_path / CONVERSATION_LOG_FILENAME).write_text("garbage\n", encoding="utf-8")
    out = _maybe_inject_pending_tool_use_note("hello", tmp_path)
    # On malformed entries read_log returns [], so no directive is added.
    assert out == "hello"


def test_inject_directive_only_when_tool_use_truly_pending(tmp_path: Path) -> None:
    """Tool_use FOLLOWED by tool_result in the log = NOT pending. No directive."""
    from agents.session import _maybe_inject_pending_tool_use_note

    _write_history(
        tmp_path,
        [
            AgentMessage(
                role=MessageRole.ASSISTANT,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_USE,
                        tool_name="Read",
                        tool_input={"file_path": "foo.py"},
                        tool_id="t1",
                    )
                ],
            ),
            AgentMessage(
                role=MessageRole.USER,
                content=[
                    ContentBlock(
                        type=ContentBlockType.TOOL_RESULT,
                        tool_use_id="t1",
                        result_content="contents",
                        is_error=False,
                    )
                ],
            ),
        ],
    )

    out = _maybe_inject_pending_tool_use_note("continue", tmp_path)
    assert out == "continue"  # tool_use was already answered
