"""The Agent Debugger runner, as the desktop app starts it: one process per call.

The state lives in a file (``WORKPILOT_AGENT_DEBUGGER_STATE``) that each test
points at its own folder, so a call sees what the previous one saved.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "agent_debugger_runner.py"


@pytest.fixture
def state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "debugger" / "state.json"
    monkeypatch.setenv("WORKPILOT_AGENT_DEBUGGER_STATE", str(path))
    return path


def _run(*args: str) -> tuple[int, dict]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=dict(os.environ),
        timeout=120,
        check=False,
    )
    [line] = done.stdout.splitlines()
    return done.returncode, json.loads(line)


def _call(action: str, payload: object | None = None) -> tuple[int, dict]:
    args = ["--action", action, "--session-id", "s1"]
    if payload is not None:
        args += ["--payload", json.dumps(payload)]
    return _run(*args)


def test_a_session_is_debugged_across_calls(state: Path, monkeypatch) -> None:
    code, out = _call("attach")
    assert code == 0 and out["session_id"] == "s1" and out["ok"] is True
    assert state.is_file()

    code, out = _call("add_bp", {"id": "bp-1", "tool": "Bash", "command_pattern": "rm"})
    assert (code, out) == (0, {"ok": True, "breakpoint_id": "bp-1"})
    [bp] = _call("list_bp")[1]["breakpoints"]
    assert (bp["tool"], bp["command_pattern"], bp["path_pattern"]) == (
        "Bash",
        "rm",
        None,
    )

    # A live agent process pauses on the breakpoint and publishes the frame.
    monkeypatch.syspath_prepend(str(BACKEND))
    from agents import debugger_store

    frame_id = debugger_store.add_frame(
        "s1", {"tool": "Bash", "tool_input": {"command": "rm -rf build"}}
    )
    [frame] = _call("list_frames")[1]["frames"]
    assert frame["frame_id"] == frame_id
    assert _call("get_state")[1]["breakpoints"] == [bp]

    code, out = _call(
        "resume", {"frame_id": frame_id, "action": "skip", "reason": "no"}
    )
    assert (code, out) == (0, {"ok": True, "reason": None})
    assert _call("list_frames")[1] == {"frames": []}
    assert debugger_store.get_frame("s1", frame_id)["resume_decision"] == {
        "action": "skip",
        "tool_input": None,
        "reason": "no",
    }
    assert _call("resume", {"frame_id": "gone"})[1] == {
        "ok": False,
        "reason": "unknown_frame",
    }

    assert _call("remove_bp", {"id": "bp-1"})[1] == {"ok": True}
    assert _call("remove_bp", {})[1] == {"ok": False}
    [session] = _run("--action", "list_sessions")[1]["sessions"]
    assert session["session_id"] == "s1"

    assert _call("detach")[1] == {"session_id": "s1", "ok": True}
    assert _call("detach")[1] == {"session_id": "s1", "ok": False}
    assert _run("--action", "list_sessions")[1] == {"sessions": []}


def test_a_session_action_needs_a_session_id(state: Path) -> None:
    assert _run("--action", "attach") == (
        1,
        {"error": "--session-id is required for action 'attach'"},
    )


def test_a_payload_that_is_not_json_is_refused(state: Path) -> None:
    code, out = _run("--action", "add_bp", "--session-id", "s1", "--payload", "{x")
    assert code == 1 and out["error"].startswith("invalid payload JSON:")


def test_a_payload_the_store_cannot_read_ends_with_an_error(state: Path) -> None:
    code, out = _call("add_bp", [1])
    assert code == 1 and "get" in out["error"]
    assert _call("list_bp")[1] == {"breakpoints": []}
