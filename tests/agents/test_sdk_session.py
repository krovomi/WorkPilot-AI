"""The raw Claude SDK session loop of ``run_agent_session``.

``create_client()`` returns a ``ClaudeSDKClient``, not an ``AgentClient``: the
planner, the coder and the QA agents built on it go through this loop. The
client here is a stand-in that streams the SDK's own message shapes (the loop
reads them by class name), so everything after the model is real: the task
log, the resume marker, the usage ledger, the replay record and the error
classification the coder's retry loop relies on.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest
from agents.session import run_agent_session
from replay import recorder as replay_recorder

# -- the SDK's message shapes, by name ---------------------------------------


class TextBlock:
    def __init__(self, text: str) -> None:
        self.text = text


class ToolUseBlock:
    def __init__(self, name: str, input: Any) -> None:  # noqa: A002 - SDK name
        self.name = name
        self.input = input
        self.id = f"tool-{name}"


class ToolResultBlock:
    def __init__(self, content: Any, is_error: bool = False) -> None:
        self.content = content
        self.is_error = is_error


class AssistantMessage:
    def __init__(self, *blocks: Any) -> None:
        self.content = list(blocks)


class UserMessage:
    def __init__(self, *blocks: Any) -> None:
        self.content = list(blocks)


class SystemMessage:
    def __init__(self, session_id: str) -> None:
        self.data = {"session_id": session_id}


class ResultMessage:
    def __init__(self, session_id: str, usage: Any, cost: float | None) -> None:
        self.session_id = session_id
        self.subtype = "success"
        self.usage = usage
        self.total_cost_usd = cost


class _Options:
    model = "claude-sonnet-test"


class _SdkClient:
    """A ``ClaudeSDKClient`` stand-in: not an AgentClient, SDK messages out."""

    def __init__(self, messages: list[Any], fail: Exception | None = None) -> None:
        self.options = _Options()
        self._messages = messages
        self._fail = fail
        self.prompts: list[str] = []

    async def query(self, prompt: str) -> None:
        self.prompts.append(prompt)
        if self._fail is not None:
            raise self._fail

    async def receive_response(self):
        for message in self._messages:
            yield message


class _Stream:
    """The live view: records what the session streams to it."""

    def __init__(self, broken: bool = False) -> None:
        self.calls: list[tuple] = []
        self._broken = broken

    async def _record(self, *call: Any) -> None:
        self.calls.append(call)
        if self._broken:
            raise RuntimeError("live view gone")

    async def emit_agent_thinking(self, text: str) -> None:
        await self._record("thinking", text)

    async def emit_tool_use(self, name: str, display: Any) -> None:
        await self._record("tool", name, display)

    async def emit_file_change(self, path: str, kind: str, content: Any) -> None:
        await self._record("file", path, kind, content)

    async def emit_command(self, command: str) -> None:
        await self._record("command", command)

    async def emit_command_output(self, output: str, is_error: bool) -> None:
        await self._record("output", output, is_error)


@pytest.fixture
def spec_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    spec = tmp_path / "project" / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    monkeypatch.setattr(
        replay_recorder,
        "_replay_recorder",
        replay_recorder.ReplayRecorder(storage_dir=tmp_path / "replays"),
    )
    monkeypatch.setenv(
        "WORKPILOT_AGENT_DEBUGGER_STATE", str(tmp_path / "debugger" / "state.json")
    )
    # The usage ledger is the project's cost_data.json; the analytics database
    # of the machine is left alone.
    import core.usage_tracker as usage_tracker

    monkeypatch.setattr(usage_tracker, "_get_analytics_db_session", lambda: None)
    return spec


def _replays(spec_dir: Path) -> list[dict]:
    folder = spec_dir.parents[3] / "replays"
    return [
        json.loads(p.read_text(encoding="utf-8")) for p in sorted(folder.glob("*.json"))
    ]


def _plan(spec_dir: Path, *statuses: str) -> None:
    plan = {
        "phases": [
            {
                "id": "p1",
                "subtasks": [
                    {"id": f"s{i}", "status": status}
                    for i, status in enumerate(statuses)
                ],
            }
        ]
    }
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


@pytest.mark.asyncio
async def test_a_session_streams_its_text_and_tools_and_records_them(
    spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    stream = _Stream()
    client = _SdkClient(
        [
            SystemMessage("sess-early"),
            AssistantMessage(TextBlock("Adding the login form. ")),
            AssistantMessage(
                ToolUseBlock("Write", {"file_path": "src/login.ts", "content": "x"})
            ),
            UserMessage(ToolResultBlock("written")),
            AssistantMessage(ToolUseBlock("Bash", {"command": "npm test"})),
            UserMessage(ToolResultBlock("1 passed")),
            AssistantMessage(TextBlock("Done.")),
            ResultMessage(
                "sess-final",
                {
                    "input_tokens": 1200,
                    "output_tokens": 300,
                    "cache_creation_input_tokens": 10,
                    "cache_read_input_tokens": 20,
                },
                0.05,
            ),
        ]
    )

    status, response, error = await run_agent_session(
        client, "add a login form", spec_dir, streaming_wrapper=stream
    )

    assert (status, error) == ("continue", {})
    assert response == "Adding the login form. Done."
    assert client.prompts == ["add a login form"]
    # The resume marker names the session that just ran, as it ended.
    marker = json.loads((spec_dir / ".session.json").read_text(encoding="utf-8"))
    assert marker == {
        "session_id": "sess-final",
        "subtype": "success",
        "model": "claude-sonnet-test",
        "phase": "coding",
        "provider": "claude",
    }
    # The live view saw the thinking, both tools, the file and the command.
    kinds = [call[0] for call in stream.calls]
    assert kinds == [
        "thinking",
        "tool",
        "file",
        "tool",
        "command",
        "output",
        "thinking",
    ]
    assert ("output", "1 passed", False) in stream.calls
    # The SDK's usage reached the project's ledger.
    [record] = json.loads(
        (spec_dir.parents[2] / ".workpilot" / "cost_data.json").read_text(
            encoding="utf-8"
        )
    )["usages"]
    assert record["input_tokens"] == 1200
    assert record["output_tokens"] == 300
    assert record["cost"] == pytest.approx(0.05)
    assert record["model"] == "claude-sonnet-test"
    # And the replay has the steps, with the usage.
    [replay] = _replays(spec_dir)
    assert replay["provider"] == "claude"
    assert replay["status"] == "completed"
    assert replay["total_tokens"] == 1500
    out = capsys.readouterr().out
    assert "Sending prompt to Claude Agent SDK" in out
    assert "[Done]" in out


@pytest.mark.asyncio
async def test_blocked_and_failed_tools_are_logged_as_failures(
    spec_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    long_input = {"command": "echo " + "x" * 400}
    client = _SdkClient(
        [
            AssistantMessage(ToolUseBlock("Bash", {"command": "rm -rf /"})),
            UserMessage(ToolResultBlock("Command blocked by security hook", True)),
            AssistantMessage(ToolUseBlock("Bash", long_input)),
            UserMessage(ToolResultBlock("exit 1: no such file", True)),
            AssistantMessage(ToolUseBlock("Read", {"file_path": "a.py"})),
            UserMessage(ToolResultBlock("print('a')")),
            # A result with no pending tool, and a block the loop ignores.
            UserMessage(ToolResultBlock("stray")),
            UserMessage(TextBlock("not a tool result")),
        ]
    )

    status, _response, _ = await run_agent_session(
        client, "go", spec_dir, verbose=True, streaming_wrapper=_Stream(broken=True)
    )

    assert status == "continue"
    out = capsys.readouterr().out
    assert "[BLOCKED] Command blocked by security hook" in out
    assert "[Error] exit 1: no such file" in out
    assert "[Done] print('a')" in out
    # verbose shows the tool input, cut at 300 characters.
    assert f"Input: {str(long_input)[:300]}..." in out
    assert "Input: {'file_path': 'a.py'}" in out
    entries = json.loads((spec_dir / "task_logs.json").read_text(encoding="utf-8"))
    tool_ends = [
        e
        for phase in entries["phases"].values()
        for e in phase["entries"]
        if e.get("type") == "tool_end"
    ]
    assert [e["content"].split(":")[0] for e in tool_ends] == [
        "[Bash] Error",
        "[Bash] Error",
        "[Read] Done",
    ]


@pytest.mark.asyncio
async def test_a_session_that_finishes_the_plan_is_complete(spec_dir: Path) -> None:
    _plan(spec_dir, "completed", "completed")
    client = _SdkClient([AssistantMessage(TextBlock("All subtasks done."))])

    status, response, error = await run_agent_session(client, "go", spec_dir)

    assert (status, response, error) == ("complete", "All subtasks done.", {})


@pytest.mark.asyncio
async def test_a_model_the_account_cannot_use_stops_the_loop(spec_dir: Path) -> None:
    text = (
        "There's an issue with the selected model (claude-x). "
        "It may not exist or you may not have access to it."
    )
    client = _SdkClient([AssistantMessage(TextBlock(text))])

    status, response, error = await run_agent_session(client, "go", spec_dir)

    assert status == "error"
    assert error == {"type": "model_unavailable", "message": text}
    assert response == text


@pytest.mark.asyncio
async def test_a_prompt_too_long_answer_breaks_the_resume_chain(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (spec_dir / ".session.json").write_text('{"session_id": "old"}', "utf-8")
    monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "old")
    client = _SdkClient([AssistantMessage(TextBlock("Prompt is too long"))])

    status, _response, error = await run_agent_session(client, "go", spec_dir)

    assert status == "error"
    assert error["type"] == "prompt_too_long"
    assert error["exception_type"] == "PromptTooLongResponse"
    # The next session will not resume the transcript that overflowed.
    assert not (spec_dir / ".session.json").exists()
    assert list(spec_dir.glob(".session.*.too-long.json"))
    assert "AUTO_CLAUDE_RESUME_SESSION_ID" not in os.environ


@pytest.mark.parametrize(
    ("error", "kind", "said"),
    [
        (
            RuntimeError("400 Bad Request: tool use concurrency limit"),
            "tool_concurrency",
            "Tool concurrency limit reached",
        ),
        (RuntimeError("429 Too Many Requests"), "rate_limit", "Rate limit reached"),
        (RuntimeError("401 Unauthorized"), "authentication", "Authentication error"),
        (RuntimeError("connection reset"), "other", "Error during agent session"),
    ],
)
@pytest.mark.asyncio
async def test_a_session_that_raises_is_classified_for_the_retry_loop(
    spec_dir: Path,
    capsys: pytest.CaptureFixture[str],
    error: Exception,
    kind: str,
    said: str,
) -> None:
    status, message, info = await run_agent_session(
        _SdkClient([], fail=error), "go", spec_dir
    )

    assert status == "error"
    assert info == {
        "type": kind,
        "message": message,
        "exception_type": "RuntimeError",
    }
    assert said in capsys.readouterr().out
    [replay] = _replays(spec_dir)
    assert replay["status"] == "failed"


@pytest.mark.asyncio
async def test_a_prompt_too_long_exception_breaks_the_resume_chain(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    logs = spec_dir / "conversation.jsonl"
    logs.write_text('{"role": "user"}\n', encoding="utf-8")
    (spec_dir / ".session.json").write_text('{"session_id": "old"}', "utf-8")
    monkeypatch.setenv("AUTO_CLAUDE_RESUME_SESSION_ID", "old")

    status, _message, info = await run_agent_session(
        _SdkClient([], fail=RuntimeError("Prompt is too long: 250000 tokens")),
        "go",
        spec_dir,
    )

    assert (status, info["type"]) == ("error", "prompt_too_long")
    assert "Prompt too long" in capsys.readouterr().out
    assert not (spec_dir / ".session.json").exists()
    assert "AUTO_CLAUDE_RESUME_SESSION_ID" not in os.environ


@pytest.mark.asyncio
async def test_a_session_without_usage_is_counted_with_zero_tokens(
    spec_dir: Path,
) -> None:
    client = _SdkClient(
        [AssistantMessage(TextBlock("ok")), ResultMessage("s", None, None)]
    )

    status, _, _ = await run_agent_session(client, "go", spec_dir)

    assert status == "continue"
    # The session is still counted, with no tokens and no cost.
    [record] = json.loads(
        (spec_dir.parents[2] / ".workpilot" / "cost_data.json").read_text(
            encoding="utf-8"
        )
    )["usages"]
    assert (record["input_tokens"], record["output_tokens"], record["cost"]) == (
        0,
        0,
        0.0,
    )
