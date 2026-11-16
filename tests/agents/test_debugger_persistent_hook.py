"""The agent debugger across processes: the live run's hook and the UI's store.

``core.client.create_client`` installs ``make_persistent_debugger_hook`` on a
run the debugger panel attached to. The panel speaks to the store through a
one-shot runner per click, so everything goes through the state file: the
breakpoints the hook reads, the frame it pauses on, the decision it waits for.
Here the "UI" is the store's own functions, called while the hook waits.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from agents import debugger_store as store
from agents.debugger import Breakpoint, make_persistent_debugger_hook

SESSION = "run-42"


@pytest.fixture(autouse=True)
def state_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "debugger" / "state.json"
    monkeypatch.setenv("WORKPILOT_AGENT_DEBUGGER_STATE", str(path))
    return path


def _hook(**kwargs):
    return make_persistent_debugger_hook(
        SESSION, poll_interval=0.01, timeout=kwargs.pop("timeout", 5.0)
    )


def _write_call(path: str = "src/auth.py", content: str = "token = 1") -> dict:
    return {"tool_name": "Write", "tool_input": {"file_path": path, "content": content}}


async def _paused_then(decide) -> dict:
    """Run the hook on a Write and let ``decide(frame)`` play the UI."""
    hook = _hook()
    call = asyncio.create_task(hook(_write_call()))
    for _ in range(500):
        frames = store.list_frames(SESSION)
        if frames:
            break
        await asyncio.sleep(0.01)
    [frame] = frames
    assert frame["tool_name"] == "Write"
    assert frame["tool_input"]["file_path"] == "src/auth.py"
    decide(frame)
    return await asyncio.wait_for(call, timeout=5)


# -- the live hook ---------------------------------------------------------------


def test_a_run_nobody_debugs_is_never_paused() -> None:
    assert asyncio.run(_hook()(_write_call())) == {}


def test_a_skip_from_the_panel_denies_the_tool() -> None:
    store.add_breakpoint(
        SESSION, {"id": "bp-auth", "tool": "Write", "path_pattern": "auth"}
    )

    out = asyncio.run(
        _paused_then(
            lambda f: store.resume(
                SESSION, f["frame_id"], {"action": "skip", "reason": "not this file"}
            )
        )
    )

    assert out == {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": "not this file",
        }
    }
    # The answered frame is gone from the store.
    assert store.get_frame(SESSION, "anything") is None
    assert all(not f for f in store.list_frames(SESSION))


def test_a_modify_from_the_panel_changes_the_tool_input() -> None:
    store.add_breakpoint(SESSION, {"tool": "*"})
    edited = {"file_path": "src/auth.py", "content": "token = load_token()"}

    out = asyncio.run(
        _paused_then(
            lambda f: store.resume(
                SESSION, f["frame_id"], {"action": "modify", "tool_input": edited}
            )
        )
    )

    assert out["hookSpecificOutput"]["permissionDecision"] == "allow"
    assert out["hookSpecificOutput"]["modifiedToolInput"] == edited


@pytest.mark.parametrize(
    "decision",
    [{"action": "continue"}, {"action": "modify", "tool_input": "rm -rf"}],
)
def test_a_continue_or_a_malformed_modify_lets_the_tool_run(decision: dict) -> None:
    store.add_breakpoint(SESSION, {"tool": "Write"})

    out = asyncio.run(
        _paused_then(lambda f: store.resume(SESSION, f["frame_id"], decision))
    )

    assert out == {}


def test_a_frame_removed_by_the_panel_lets_the_tool_run() -> None:
    store.add_breakpoint(SESSION, {"tool": "Write"})

    out = asyncio.run(
        _paused_then(lambda f: store.remove_frame(SESSION, f["frame_id"]))
    )

    assert out == {}


def test_an_unanswered_frame_continues_at_the_timeout() -> None:
    store.add_breakpoint(SESSION, {"tool": "Write"})

    out = asyncio.run(_hook(timeout=0.05)(_write_call()))

    assert out == {}
    assert store.list_frames(SESSION) == []


def test_calls_no_breakpoint_matches_are_not_paused() -> None:
    store.add_breakpoint(
        SESSION, {"id": "bash", "tool": "Bash", "command_pattern": "^git push"}
    )
    store.add_breakpoint(SESSION, {"id": "off", "tool": "*", "enabled": False})
    hook = _hook()

    async def calls() -> list[dict]:
        return [
            await hook({"tool_name": "Bash", "tool_input": {"command": "npm test"}}),
            await hook(_write_call()),
            await hook({"tool_name": "Write", "tool_input": "not a dict"}),
        ]

    assert asyncio.run(calls()) == [{}, {}, {}]


def test_a_breakpoint_with_a_broken_pattern_never_breaks_the_run() -> None:
    store.add_breakpoint(SESSION, {"tool": "Write", "path_pattern": "(["})

    assert asyncio.run(_hook()(_write_call())) == {}


def test_the_hook_rereads_breakpoints_only_when_the_file_changes(
    state_file: Path,
) -> None:
    hook = _hook(timeout=0.05)
    store.add_breakpoint(SESSION, {"id": "w", "tool": "Bash"})

    async def run() -> None:
        assert await hook(_write_call()) == {}
        state_file.unlink()
        assert await hook(_write_call()) == {}

    asyncio.run(run())


# -- the breakpoint itself ---------------------------------------------------------


@pytest.mark.parametrize(
    ("bp", "tool", "tool_input", "expected"),
    [
        (
            Breakpoint("b", "Bash", command_pattern="push"),
            "Bash",
            {"command": "git push"},
            True,
        ),
        (Breakpoint("b", "Bash"), "Bash", {"command": "ls"}, True),
        (
            Breakpoint("b", "Edit", content_pattern="secret"),
            "Edit",
            {"new_string": "x"},
            False,
        ),
        (
            Breakpoint("b", "Edit", content_pattern="secret"),
            "Edit",
            {"new_string": "a secret"},
            True,
        ),
        (
            Breakpoint("b", "Write", path_pattern="auth"),
            "Write",
            {"path": "ui.py"},
            False,
        ),
        (Breakpoint("b", "Write"), "Read", {"file_path": "a"}, False),
    ],
)
def test_a_breakpoint_matches_its_tool_and_patterns(
    bp: Breakpoint, tool: str, tool_input: dict, expected: bool
) -> None:
    assert bp.matches(tool, tool_input) is expected


# -- the store the panel reads -------------------------------------------------------


def test_the_panel_lists_attaches_and_detaches_sessions() -> None:
    assert store.list_sessions() == []
    summary = store.attach(SESSION)
    assert (summary["breakpoints"], summary["frames"], summary["active"]) == (
        0,
        0,
        False,
    )
    # Attaching twice keeps the session.
    store.add_breakpoint(SESSION, {"id": "a", "tool": "Write"})
    assert store.attach(SESSION)["breakpoints"] == 1

    assert [s["session_id"] for s in store.list_sessions()] == [SESSION]
    assert store.detach(SESSION) is True
    assert store.detach(SESSION) is False


def test_a_breakpoint_is_replaced_by_id_and_removed() -> None:
    store.add_breakpoint(SESSION, {"id": "a", "tool": "Write"})
    store.add_breakpoint(SESSION, {"id": "a", "tool": "Edit", "path_pattern": "x"})

    [bp] = store.list_breakpoints(SESSION)
    assert (bp["tool"], bp["path_pattern"], bp["content_pattern"]) == (
        "Edit",
        "x",
        None,
    )
    assert store.remove_breakpoint(SESSION, "missing") is False
    assert store.remove_breakpoint(SESSION, "a") is True
    assert store.remove_breakpoint("nobody", "a") is False
    assert store.list_breakpoints("nobody") == []


def test_unknown_sessions_and_frames_answer_nothing() -> None:
    store.attach(SESSION)

    assert store.list_frames("nobody") == []
    assert store.resume("nobody", "f", {"action": "continue"}) is False
    assert store.resume(SESSION, "f", {"action": "continue"}) is False
    assert store.get_frame("nobody", "f") is None
    assert store.remove_frame("nobody", "f") is False
    assert store.remove_frame(SESSION, "f") is False
    assert store.deactivate("nobody") is False


def test_a_frame_for_a_session_nobody_attached_is_kept() -> None:
    frame_id = store.add_frame(
        "late", {"tool_name": "Bash", "resume_decision": {"action": "skip"}}
    )

    [frame] = store.list_frames("late")
    assert frame["frame_id"] == frame_id
    # A new frame is always pending, whatever it was given.
    assert "resume_decision" not in frame


def test_whether_a_session_exists_and_is_armed(state_file: Path) -> None:
    assert store.session_exists(SESSION) is False
    assert store.session_is_armed(SESSION) is False

    store.attach(SESSION)
    assert store.session_exists(SESSION) is True
    assert store.session_is_armed(SESSION) is False
    assert store.session_is_armed("nobody") is False

    store.add_breakpoint(SESSION, {"tool": "Bash", "enabled": False})
    assert store.session_is_armed(SESSION) is False
    store.add_breakpoint(SESSION, {"tool": "Write"})
    assert store.session_is_armed(SESSION) is True


def test_a_live_run_is_listed_until_it_stops() -> None:
    store.register_active(SESSION, {"spec": "001-login"})
    [summary] = store.list_sessions()
    assert summary["active"] is True
    assert summary["meta"]["spec"] == "001-login"

    assert store.deactivate(SESSION) is True
    assert store.list_sessions()[0]["active"] is False


def test_finished_untouched_runs_leave_the_picker(state_file: Path) -> None:
    store.attach("old")
    store.add_breakpoint("kept", {"tool": "Write"})
    state = json.loads(state_file.read_text(encoding="utf-8"))
    for sid in ("old", "kept"):
        state["sessions"][sid]["updated_at"] = 0
    state["sessions"]["broken"] = "not a session"
    state_file.write_text(json.dumps(state), encoding="utf-8")

    store.register_active(SESSION)

    assert sorted(s["session_id"] for s in store.list_sessions()) == ["kept", SESSION]


@pytest.mark.parametrize(
    "content", ["{not json", json.dumps(["a"]), json.dumps({"sessions": []})]
)
def test_a_corrupt_state_file_reads_as_empty(state_file: Path, content: str) -> None:
    state_file.parent.mkdir(parents=True)
    state_file.write_text(content, encoding="utf-8")

    assert store.list_sessions() == []
    assert store.attach(SESSION)["session_id"] == SESSION


def test_without_an_override_the_state_lives_in_the_user_folder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("WORKPILOT_AGENT_DEBUGGER_STATE")
    # HOME on POSIX, USERPROFILE on Windows: the user folder itself is set.
    monkeypatch.setattr(Path, "home", classmethod(lambda _cls: tmp_path / "home"))

    assert store.state_path() == (
        tmp_path / "home" / ".workpilot" / "agent-debugger" / "state.json"
    )
