"""A run interrupted by closing the application continues where it stopped.

Three things have to hold for the next process to pick the work back up
instead of starting the phase over, on every provider:

* the subtask the dead process was working on is continued, not skipped
  (``get_next_subtask`` only picks ``pending`` work) and not reset;
* ``.session.json`` names the session that was interrupted — it used to be
  written only when a session ended, so it named the one before;
* the transcript reaches the new session exactly once: the conversation log
  for every provider, the SDK's own rehydration for Claude when it has one.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from core.agent_client import (
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from core.conversation_log import append_message
from task_logger import LogPhase


def _plan(spec_dir: Path, statuses: list[str]) -> Path:
    plan_file = spec_dir / "implementation_plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "feature": "f",
                "phases": [
                    {
                        "id": "p1",
                        "name": "Phase 1",
                        "subtasks": [
                            {
                                "id": f"s{i}",
                                "description": f"subtask {i}",
                                "status": status,
                                "notes": f"kept {i}",
                            }
                            for i, status in enumerate(statuses, start=1)
                        ],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    return plan_file


# --- the interrupted subtask ------------------------------------------------


def test_interrupted_subtask_is_the_next_one_again(tmp_path: Path) -> None:
    from core.progress import get_next_subtask, reopen_interrupted_subtasks

    plan_file = _plan(tmp_path, ["completed", "in_progress", "pending"])
    # Before: the dead process's subtask is invisible to the loop.
    assert get_next_subtask(tmp_path)["id"] == "s3"

    assert reopen_interrupted_subtasks(tmp_path) == ["s2"]

    nxt = get_next_subtask(tmp_path)
    assert nxt["id"] == "s2"
    subtask = json.loads(plan_file.read_text(encoding="utf-8"))["phases"][0][
        "subtasks"
    ][1]
    assert subtask["status"] == "pending"
    assert subtask["interrupted_at"]
    # Nothing it recorded is thrown away — unlike the Kanban's stuck recovery.
    assert subtask["notes"] == "kept 2"


def test_last_subtask_interrupted_is_not_reported_as_a_finished_build(
    tmp_path: Path,
) -> None:
    from core.progress import get_next_subtask, reopen_interrupted_subtasks

    _plan(tmp_path, ["completed", "in_progress"])
    assert get_next_subtask(tmp_path) is None  # "build may be complete"

    reopen_interrupted_subtasks(tmp_path)

    assert get_next_subtask(tmp_path)["id"] == "s2"


def test_nothing_interrupted_writes_nothing(tmp_path: Path) -> None:
    from core.progress import reopen_interrupted_subtasks

    plan_file = _plan(tmp_path, ["completed", "pending"])
    before = plan_file.read_text(encoding="utf-8")

    assert reopen_interrupted_subtasks(tmp_path) == []
    assert plan_file.read_text(encoding="utf-8") == before


def test_no_plan_or_a_broken_plan_reopens_nothing(tmp_path: Path) -> None:
    from core.progress import reopen_interrupted_subtasks

    assert reopen_interrupted_subtasks(tmp_path) == []
    (tmp_path / "implementation_plan.json").write_text("{not json", encoding="utf-8")
    assert reopen_interrupted_subtasks(tmp_path) == []


def test_the_prompt_says_the_work_is_half_done(tmp_path: Path) -> None:
    from core.progress import interrupted_subtask_directive

    assert interrupted_subtask_directive({"id": "s1"}) == ""
    directive = interrupted_subtask_directive(
        {"id": "s1", "interrupted_at": "2026-09-27T10:00:00+00:00"}
    )
    assert "git diff" in directive
    assert "Do not" in directive


# --- the session marker -----------------------------------------------------


class _FakeClient:
    """AgentClient stand-in that learns its session id from the first message,
    the way ClaudeAgentClient does from the SDK's init message."""

    def __init__(
        self,
        messages: list[AgentMessage],
        *,
        provider: str = "claude",
        session_id: str | None = "sess-running",
        native_resume: bool = False,
        spec_dir: Path | None = None,
    ):
        self.model = "claude-test"
        self._messages = messages
        self._provider = provider
        self._session_id = session_id
        self._native_resume = native_resume
        self._spec_dir = spec_dir
        self.last_session_id: str | None = None
        self.last_usage: dict | None = None
        self.resumed_with: list[AgentMessage] | None = None
        self.marker_seen_mid_stream: dict | None = None

    def provider_name(self) -> str:
        return self._provider

    def resumes_native_session(self) -> bool:
        return self._native_resume

    async def resume(self, history: list[AgentMessage]) -> None:
        self.resumed_with = history

    async def query(self, prompt: str) -> None:  # noqa: ARG002 - fake
        self.last_session_id = None

    async def receive_response(self) -> AsyncIterator[AgentMessage]:
        for index, message in enumerate(self._messages):
            if index == 0:
                self.last_session_id = self._session_id
            if index == 1 and self._spec_dir is not None:
                marker = self._spec_dir / ".session.json"
                if marker.exists():
                    self.marker_seen_mid_stream = json.loads(
                        marker.read_text(encoding="utf-8")
                    )
            yield message


def _text(role: MessageRole, text: str) -> AgentMessage:
    return AgentMessage(
        role=role, content=[ContentBlock(type=ContentBlockType.TEXT, text=text)]
    )


async def _run(client: _FakeClient, spec_dir: Path):
    from agents.session import _run_agent_client_session

    return await _run_agent_client_session(
        client, "implement the thing", spec_dir, verbose=False, phase=LogPhase.CODING
    )


@pytest.mark.asyncio
async def test_marker_names_the_running_session_before_it_ends(
    tmp_path: Path,
) -> None:
    # A marker left by the session before this one.
    (tmp_path / ".session.json").write_text(
        json.dumps({"session_id": "sess-previous", "phase": "planning"}),
        encoding="utf-8",
    )
    client = _FakeClient(
        [
            _text(MessageRole.ASSISTANT, "Reading the files."),
            _text(MessageRole.ASSISTANT, "Editing main.py."),
        ],
        spec_dir=tmp_path,
    )

    await _run(client, tmp_path)

    # Mid-stream — i.e. what a process killed right there would leave behind.
    assert client.marker_seen_mid_stream is not None
    assert client.marker_seen_mid_stream["session_id"] == "sess-running"
    assert client.marker_seen_mid_stream["provider"] == "claude"
    assert client.marker_seen_mid_stream["phase"] == LogPhase.CODING.value


@pytest.mark.asyncio
async def test_marker_records_a_provider_that_is_not_claude(tmp_path: Path) -> None:
    client = _FakeClient(
        [_text(MessageRole.ASSISTANT, "ok")],
        provider="codex",
        session_id="thread-1",
    )

    await _run(client, tmp_path)

    marker = json.loads((tmp_path / ".session.json").read_text(encoding="utf-8"))
    # The frontend reads this to refuse handing a Codex thread id to the
    # Claude SDK as a session to rehydrate.
    assert marker["provider"] == "codex"


def test_session_id_is_read_from_the_init_message() -> None:
    from agents.session import _session_id_of

    class _Init:
        subtype = "init"
        data = {"session_id": "sess-init"}

    class _Result:
        session_id = "sess-result"

    assert _session_id_of(_Init()) == "sess-init"
    assert _session_id_of(_Result()) == "sess-result"
    assert _session_id_of(object()) is None


# --- the transcript, exactly once ------------------------------------------


def _log_history(spec_dir: Path, provider: str, model: str) -> None:
    for message in (
        _text(MessageRole.USER, "implement subtask s2"),
        _text(MessageRole.ASSISTANT, "I created api/routes.py, next the tests."),
    ):
        append_message(
            spec_dir, message, phase="coding", provider=provider, model=model
        )


@pytest.mark.asyncio
async def test_every_provider_gets_the_interrupted_transcript_back(
    tmp_path: Path,
) -> None:
    _log_history(tmp_path, "ollama", "claude-test")
    client = _FakeClient([_text(MessageRole.ASSISTANT, "ok")], provider="ollama")

    await _run(client, tmp_path)

    assert client.resumed_with is not None
    assert any(
        "api/routes.py" in (block.text or "")
        for message in client.resumed_with
        for block in message.content
    )


@pytest.mark.asyncio
async def test_native_claude_resume_is_not_replayed_twice(tmp_path: Path) -> None:
    _log_history(tmp_path, "claude", "claude-test")
    client = _FakeClient([_text(MessageRole.ASSISTANT, "ok")], native_resume=True)

    await _run(client, tmp_path)

    assert client.resumed_with is None


def test_a_session_the_sdk_cannot_open_is_not_resumed(tmp_path: Path) -> None:
    from core.client import _claude_transcript_exists

    config_dir = tmp_path / "profile"
    project = config_dir / "projects" / "-home-me-repo"
    project.mkdir(parents=True)
    (project / "sess-ok.jsonl").write_text("{}\n", encoding="utf-8")

    assert _claude_transcript_exists("sess-ok", str(config_dir)) is True
    assert _claude_transcript_exists("sess-gone", str(config_dir)) is False
    assert _claude_transcript_exists("../sess-ok", str(config_dir)) is False
    assert _claude_transcript_exists("", str(config_dir)) is False
