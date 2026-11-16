"""Telemetry never costs a session: a replay store or a debugger state that
fails turns the recording off, and the session goes on.

The failures here are real ones: a replay folder replaced by a file, a
debugger state whose folder is a file, a temporary state file that is a
folder. Nothing is patched but where the stores live.
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

import pytest
from agents import debugger_store
from agents.session_recording import SessionRecording
from replay import recorder as replay_recorder
from task_logger import LogPhase


@pytest.fixture
def replays(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    folder = tmp_path / "replays"
    monkeypatch.setattr(
        replay_recorder,
        "_replay_recorder",
        replay_recorder.ReplayRecorder(storage_dir=folder),
    )
    return folder


@pytest.fixture
def state(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "debugger" / "state.json"
    monkeypatch.setenv("WORKPILOT_AGENT_DEBUGGER_STATE", str(path))
    return path


@pytest.fixture
def spec_dir(tmp_path: Path) -> Path:
    spec = tmp_path / "project" / ".workpilot" / "specs" / "001-login"
    spec.mkdir(parents=True)
    return spec


def _block_folder(folder: Path) -> None:
    """Put a file where a store expects its folder."""
    shutil.rmtree(folder, ignore_errors=True)
    folder.parent.mkdir(parents=True, exist_ok=True)
    folder.write_text("in the way", encoding="utf-8")


def _recording(spec_dir: Path) -> SessionRecording:
    return SessionRecording(spec_dir, LogPhase.CODING, provider="openai", model="m")


def test_a_replay_store_that_cannot_be_written_records_nothing(
    replays: Path, state: Path, spec_dir: Path
) -> None:
    _block_folder(replays)

    recording = _recording(spec_dir)
    recording.text("still answering")
    recording.end()

    assert replays.is_file()
    # Started in memory but never saved: nothing more reached it.
    [session] = replay_recorder._replay_recorder._active_sessions.values()
    assert [step.step_type.value for step in session.steps] == ["session_start"]
    # The debugger still heard of the run, and of its end.
    session = debugger_store._load()["sessions"]["001-login"]
    assert session["active"] is False


def test_a_replay_that_fails_on_the_way_stops_recording(
    replays: Path, state: Path, spec_dir: Path
) -> None:
    recording = _recording(spec_dir)
    recording.text("first answer")
    _block_folder(replays)

    # The end cannot be saved: the recording stops instead of raising.
    recording.end("failed")
    recording.text("after the end")

    assert replays.is_file()


def test_a_debugger_state_that_cannot_be_written_is_not_announced(
    replays: Path, state: Path, spec_dir: Path
) -> None:
    _block_folder(state.parent)

    recording = _recording(spec_dir)
    recording.text("answering")
    recording.end()

    # The replay was still saved.
    [saved] = [
        json.loads(p.read_text(encoding="utf-8")) for p in replays.glob("*.json")
    ]
    assert saved["status"] == "completed"
    assert state.parent.is_file()


def test_a_run_that_cannot_be_taken_off_the_list_ends_anyway(
    replays: Path, state: Path, spec_dir: Path
) -> None:
    recording = _recording(spec_dir)
    assert debugger_store._load()["sessions"]["001-login"]["active"] is True
    # The next atomic write goes through this temporary file: make it a folder.
    state.with_suffix(f".{os.getpid()}.tmp").mkdir()

    recording.end()

    assert debugger_store._load()["sessions"]["001-login"]["active"] is True


def test_a_spec_without_a_name_is_recorded_but_not_announced(
    replays: Path, state: Path
) -> None:
    recording = SessionRecording(
        Path("/"), LogPhase.PLANNING, provider="claude", model="m"
    )
    recording.end()

    assert not state.exists()
    assert len(list(replays.glob("*.json"))) == 1


def test_usage_that_is_not_a_number_is_ignored(
    replays: Path, state: Path, spec_dir: Path
) -> None:
    recording = _recording(spec_dir)
    recording.usage("many", 10, None)
    recording.usage(None, None, None)
    recording.usage(100, "20", "0.5")
    recording.end()

    [saved] = [
        json.loads(p.read_text(encoding="utf-8")) for p in replays.glob("*.json")
    ]
    assert saved["total_tokens"] == 120
    assert saved["total_cost_usd"] == pytest.approx(0.5)


def test_a_result_without_a_tool_call_adds_no_step(
    replays: Path, state: Path, spec_dir: Path
) -> None:
    recording = _recording(spec_dir)
    recording.tool_result("orphan output", is_error=False)
    recording.end()

    [saved] = [
        json.loads(p.read_text(encoding="utf-8")) for p in replays.glob("*.json")
    ]
    assert [s["step_type"] for s in saved["steps"]] == [
        "session_start",
        "session_end",
    ]


def test_a_client_without_usage_reports_none() -> None:
    from agents.session_recording import client_usage

    class _Client:
        last_usage = None

    assert client_usage(_Client()) == (0, 0, 0.0)
    assert client_usage(object()) == (0, 0, 0.0)
