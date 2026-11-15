"""`--streaming-server`, `--list-recordings`, `--replay-recording`."""

from __future__ import annotations

import json
import time

import pytest
import streaming
from cli import streaming_commands as stc
from cli.main import parse_args
from streaming import SessionRecorder
from streaming.session_recorder import SessionRecording
from streaming.streaming_manager import EventType, StreamingEvent


@pytest.fixture
def home(tmp_path, monkeypatch):
    """Recordings live under the user's home: give the test its own."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("USERPROFILE", str(tmp_path))
    return tmp_path / ".workpilot" / "recordings"


def _recording(session_id="s-1", events=2):
    start = time.time() - 120
    return SessionRecording(
        session_id=session_id,
        start_time=start,
        end_time=start + 90,
        metadata={},
        events=[
            StreamingEvent(
                EventType.AGENT_RESPONSE,
                start + i * 0.01,
                {"text": f"e{i}"},
                session_id,
            )
            for i in range(events)
        ],
    )


def test_no_recordings(home, capsys):
    assert stc.handle_list_recordings_command(parse_args(["--list-recordings"])) == 0
    assert "No recordings found" in capsys.readouterr().out


def test_recordings_are_listed(home, capsys):
    path = SessionRecorder().save_recording(_recording())

    assert stc.handle_list_recordings_command(parse_args(["--list-recordings"])) == 0

    out = capsys.readouterr().out
    assert "Streaming Session Recordings (1)" in out
    assert "1. Session: s-1" in out
    assert "Duration: 1.5 minutes" in out
    assert "Events: 2" in out
    assert f"File: {path}" in out


def test_a_recording_is_replayed_from_the_parsed_arguments(home, capsys):
    """`--replay-recording FILE` is the file: the command used to read an
    attribute the parser never sets."""
    path = SessionRecorder().save_recording(_recording())
    args = parse_args(["--replay-recording", str(path), "--speed", "100"])

    assert stc.handle_replay_recording_command(args) == 0

    out = capsys.readouterr().out
    assert "Replaying Session: s-1" in out
    assert "Speed: 100.0x" in out
    assert "[agent_response] {'text': 'e0'}" in out
    assert "[agent_response] {'text': 'e1'}" in out
    assert "Replay completed" in out


def test_replay_without_a_file(home, capsys):
    args = parse_args([])
    assert stc.handle_replay_recording_command(args) == 1
    assert "--replay-recording" in capsys.readouterr().out


def test_replay_of_a_missing_file(home, tmp_path, capsys):
    args = parse_args(["--replay-recording", str(tmp_path / "gone.json")])
    assert stc.handle_replay_recording_command(args) == 1
    assert "Recording file not found" in capsys.readouterr().out


def test_replay_of_a_broken_file(home, tmp_path, capsys):
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps({"session_id": "x"}), encoding="utf-8")
    args = parse_args(["--replay-recording", str(broken)])
    assert stc.handle_replay_recording_command(args) == 1
    assert "Failed to replay recording" in capsys.readouterr().out


class _Server:
    host = "localhost"
    port = 8765

    def __init__(self, sessions):
        self.sessions = list(sessions)

    def get_active_sessions(self):
        if not self.sessions:
            raise KeyboardInterrupt
        return self.sessions.pop(0)


@pytest.fixture
def server(monkeypatch):
    calls = []
    fake = _Server([["a", "b"], []])

    async def start():
        calls.append(("start", fake.port))

    async def stop():
        calls.append(("stop",))

    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(streaming, "start_streaming_server", start)
    monkeypatch.setattr(streaming, "stop_streaming_server", stop)
    monkeypatch.setattr(streaming, "get_websocket_server", lambda: fake)
    monkeypatch.setattr(stc.asyncio, "sleep", no_wait)
    return calls


def test_the_server_listens_on_the_chosen_port_until_ctrl_c(server, capsys):
    args = parse_args(["--streaming-server", "--streaming-port", "9911"])

    assert stc.handle_streaming_server_command(args) == 0

    assert server == [("start", 9911), ("stop",)]
    out = capsys.readouterr().out
    assert "running on ws://localhost:9911" in out
    assert "Active sessions: 2" in out
    assert "stopped by user" in out


def test_a_server_that_fails_to_start(monkeypatch, capsys):
    async def broken(_args):
        raise OSError("address in use")

    monkeypatch.setattr(stc, "_run_streaming_server", broken)
    assert stc.handle_streaming_server_command(parse_args([])) == 1
    assert "Failed to start streaming server: address in use" in capsys.readouterr().out
