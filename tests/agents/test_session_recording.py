"""Every agent session reaches the Replay and Debugger views, whatever its provider.

The planner and the coder run through ``_run_agent_client_session`` for every
provider, Claude included, and that loop recorded nothing: the "Agent de
Replay" view stayed empty after real builds. The raw SDK loop did record, but
its phase map named ``LogPhase.QA_FIX``, which does not exist, so its recording
died on an ``AttributeError`` swallowed at start. And no loop told the Agent
Debugger a run existed, so there was nothing to attach to.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents import debugger_store
from agents.session import run_agent_session
from agents.session_recording import SessionRecording
from core.agent_client import (
    AgentClient,
    AgentMessage,
    ContentBlock,
    ContentBlockType,
    MessageRole,
)
from replay import recorder as replay_recorder
from task_logger import LogPhase


@pytest.fixture
def stores(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The replay store and the debugger state, in the test's own folder."""
    replays = tmp_path / "replays"
    monkeypatch.setattr(
        replay_recorder,
        "_replay_recorder",
        replay_recorder.ReplayRecorder(storage_dir=replays),
    )
    monkeypatch.setenv(
        "WORKPILOT_AGENT_DEBUGGER_STATE", str(tmp_path / "debugger" / "state.json")
    )
    return replays


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    spec = tmp_path / "project" / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    return spec


def _saved(replays: Path) -> list[dict]:
    return [
        json.loads(p.read_text(encoding="utf-8"))
        for p in sorted(replays.glob("*.json"))
    ]


class _ScriptedClient(AgentClient):
    """An OpenAI-style client: it names its tools write_file and run_command."""

    def __init__(self, messages: list[AgentMessage]) -> None:
        self._messages = messages
        self.model = "gpt-5"
        self.last_usage = {"input_tokens": 1200, "output_tokens": 300, "cost_usd": 0.02}

    async def query(self, prompt: str) -> None:
        self.prompt = prompt

    async def receive_response(self):
        for message in self._messages:
            yield message

    def supports_subagents(self) -> bool:
        return False

    def provider_name(self) -> str:
        return "openai"

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:
        return None


def _assistant(*blocks: ContentBlock) -> AgentMessage:
    return AgentMessage(role=MessageRole.ASSISTANT, content=list(blocks))


@pytest.mark.asyncio
async def test_a_non_claude_build_session_is_saved_for_replay(
    stores: Path, spec_dir: Path
) -> None:
    client = _ScriptedClient(
        [
            _assistant(
                ContentBlock(type=ContentBlockType.TEXT, text="Adding the login form.")
            ),
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name="write_file",
                    tool_input={"path": "src/login.ts", "content": "export {}"},
                )
            ),
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT, result_content="written"
                )
            ),
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_USE,
                    tool_name="run_command",
                    tool_input={"command": "npm test"},
                )
            ),
            _assistant(
                ContentBlock(
                    type=ContentBlockType.TOOL_RESULT, result_content="1 passed"
                )
            ),
        ]
    )

    status, _, _ = await run_agent_session(
        client, "go", spec_dir, phase=LogPhase.CODING
    )

    assert status == "continue"
    [session] = _saved(stores)
    assert session["provider"] == "openai"
    assert session["model"] == "gpt-5"
    assert session["agent_role"] == "coder"
    assert session["task_description"] == "001-login"
    assert session["status"] == "completed"
    assert [step["step_type"] for step in session["steps"]] == [
        "session_start",
        "agent_response",
        "file_create",
        "command_run",
        "command_output",
        "session_end",
    ]
    assert session["steps"][2]["file_diffs"][0]["file_path"] == "src/login.ts"
    assert session["steps"][3]["label"] == "Command: npm test"
    assert session["total_tokens"] == 1500


@pytest.mark.asyncio
async def test_a_session_that_fails_is_saved_as_failed(
    stores: Path, spec_dir: Path
) -> None:
    class _Broken(_ScriptedClient):
        async def query(self, prompt: str) -> None:
            raise RuntimeError("provider down")

    status, _, _ = await run_agent_session(_Broken([]), "go", spec_dir)

    assert status == "error"
    [session] = _saved(stores)
    assert session["status"] == "failed"


@pytest.mark.usefixtures("stores")
def test_the_run_is_listed_for_the_debugger_while_it_runs(spec_dir: Path) -> None:
    recording = SessionRecording(
        spec_dir, LogPhase.CODING, provider="mistral", model="m"
    )

    [listed] = debugger_store.list_sessions()
    assert listed["session_id"] == "001-login"
    assert listed["active"] is True
    assert listed["meta"]["provider"] == "mistral"
    assert listed["meta"]["agent_type"] == "coder"

    recording.end()
    recording.end()  # a second end changes nothing

    [listed] = debugger_store.list_sessions()
    assert listed["active"] is False


@pytest.mark.usefixtures("stores")
def test_finished_untouched_runs_leave_the_debugger_list(
    spec_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    SessionRecording(spec_dir, LogPhase.CODING, provider="x", model="y").end()
    debugger_store.add_breakpoint("002-kept", {"id": "bp", "tool": "Bash"})

    later = debugger_store.time.time() + 8 * 24 * 3600
    monkeypatch.setattr(debugger_store.time, "time", lambda: later)
    debugger_store.register_active("003-new")

    ids = {s["session_id"] for s in debugger_store.list_sessions()}
    assert ids == {"002-kept", "003-new"}


def test_without_a_spec_nothing_is_recorded(stores: Path) -> None:
    recording = SessionRecording(None, LogPhase.CODING, provider="x", model="y")
    recording.text("hello")
    recording.end()

    assert _saved(stores) == []
    assert debugger_store.list_sessions() == []


def test_the_sdk_tool_names_are_recorded_too(stores: Path, spec_dir: Path) -> None:
    recording = SessionRecording(spec_dir, "planning", provider="claude", model="opus")
    recording.tool_use("Edit", {"file_path": "a.py", "new_string": "x = 1"})
    recording.tool_result("ok", is_error=False)
    recording.tool_use("Bash", {"command": "pytest"})
    recording.tool_result("boom", is_error=True)
    recording.tool_use("Grep", {"pattern": "def"})
    recording.tool_result("a.py:1", is_error=False)
    recording.usage(10, 5, 0.001)
    recording.end()

    [session] = _saved(stores)
    assert session["agent_role"] == "planner"
    assert [step["step_type"] for step in session["steps"]][1:-1] == [
        "file_update",
        "command_run",
        "command_output",
        "tool_call",
        "tool_result",
    ]
    assert session["total_tokens"] == 15
