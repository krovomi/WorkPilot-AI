"""What an agent's streaming session leaves behind, and the pieces it goes through.

The agent wrapper connects to a real streaming server (or to none) and records
its events on disk, secrets masked; the recorder saves, lists and replays them
with their real timing; the manager broadcasts and drops broken viewers; the
project rooms of server mode keep working when their chat store does not.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import socket
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from streaming import agent_wrapper as wrapper_module
from streaming import project_room
from streaming import websocket_server as ws_server
from streaming.agent_wrapper import StreamingAgentWrapper
from streaming.project_room import Member, ProjectRooms
from streaming.session_recorder import SessionRecorder, SessionRecording
from streaming.streaming_manager import EventType, StreamingEvent, StreamingManager

SECRET = "ghp_" + "a1B2" * 9


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def _wrapper(tmp_path: Path, port: int) -> StreamingAgentWrapper:
    wrapper = StreamingAgentWrapper(
        "task-1", enable_recording=False, ws_host="127.0.0.1", ws_port=port
    )
    wrapper.recorder = SessionRecorder(recordings_dir=tmp_path)
    return wrapper


class _Socket:
    """A viewer's connection: what it was sent."""

    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))


def _event(at: float, kind: EventType = EventType.TOOL_USE) -> StreamingEvent:
    return StreamingEvent(event_type=kind, timestamp=at, data={}, session_id="s1")


class TestAgentWrapper:
    async def test_events_reach_the_viewers_and_the_recording(self, tmp_path):
        server = ws_server.StreamingWebSocketServer("127.0.0.1", _free_port())
        server.streaming_manager = StreamingManager()
        await server.start()
        viewer = _Socket()
        server._clients["task-1"] = {viewer}
        wrapper = _wrapper(tmp_path, server.port)
        try:
            await wrapper.start_session({"task": "cart", "key": SECRET})
            await wrapper.emit_tool_use("Bash", f"curl -H 'token {SECRET}'")
            await wrapper.emit_test_run("pytest")
            await wrapper.emit_test_result(True, "3 passed")
            await wrapper.emit_progress(0.5, "halfway", "tests")
            await wrapper.emit_chat_message("done")
            for _ in range(200):
                if len(viewer.sent) >= 6:
                    break
                await asyncio.sleep(0.01)
            await wrapper.end_session()
        finally:
            await server.stop()

        assert [e["event_type"] for e in viewer.sent][:6] == [
            "session_start",
            "tool_use",
            "test_run",
            "test_result",
            "progress_update",
            "chat_message",
        ]
        assert SECRET in json.dumps(viewer.sent)  # live viewers see the real text
        [saved] = list(tmp_path.glob("*.json"))
        recording = json.loads(saved.read_text(encoding="utf-8"))
        assert recording["event_count"] == 7
        assert recording["events"][-1]["event_type"] == "session_end"
        assert SECRET not in saved.read_text(encoding="utf-8")
        assert recording["metadata"]["task"] == "cart"
        assert wrapper._ws is None

    async def test_a_session_without_a_server_is_still_recorded(
        self, tmp_path, monkeypatch, caplog
    ):
        monkeypatch.setenv("WORKPILOT_WS_TOKEN", "tok-" + "z" * 20)
        wrapper = _wrapper(tmp_path, _free_port())

        with caplog.at_level(logging.DEBUG, logger=wrapper_module.__name__):
            await wrapper.start_session({"task": "t"})
            await wrapper.emit_agent_thinking("thinking")
            await wrapper.end_session()

        recording = wrapper.recorder.load_recording(next(tmp_path.glob("*.json")))
        assert [e.event_type.value for e in recording.events] == [
            "session_start",
            "agent_thinking",
            "session_end",
        ]
        assert "Could not connect to streaming server" in caplog.text
        assert "tok-" not in caplog.text

    async def test_a_reconnect_goes_back_to_the_address_that_worked(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setenv("WORKPILOT_WS_TOKEN", "abc")
        tried: list[str] = []

        async def timeout(url, **_kwargs):
            tried.append(url)
            raise TimeoutError

        monkeypatch.setattr(wrapper_module.websockets, "connect", timeout)
        wrapper = _wrapper(tmp_path, 9)
        wrapper._connected_url = "ws://127.0.0.1:9/stream/task-1?token=abc"

        assert await wrapper._connect() is False
        assert tried == ["ws://127.0.0.1:9/stream/task-1?token=abc"]

    async def test_a_socket_that_fails_to_close_is_dropped(self, tmp_path):
        class Stuck:
            async def close(self):
                raise OSError("reset")

        wrapper = _wrapper(tmp_path, 9)
        wrapper._ws, wrapper._connected = Stuck(), True

        await wrapper._disconnect()

        assert (wrapper._ws, wrapper._connected) == (None, False)

    @pytest.mark.parametrize(
        ("emit", "args"),
        [
            ("emit_command_output", ("out",)),
            ("emit_test_run", ("pytest",)),
            ("emit_test_result", (True,)),
            ("emit_progress", (0.1, "s")),
            ("emit_tool_use", ("Read",)),
            ("emit_chat_message", ("hi",)),
        ],
    )
    async def test_nothing_is_sent_outside_a_session(self, tmp_path, emit, args):
        wrapper = _wrapper(tmp_path, 9)
        sent: list = []

        async def record(*event):
            sent.append(event)

        wrapper._send_event = record
        await getattr(wrapper, emit)(*args)

        assert sent == []

    def test_secrets_are_masked_at_every_depth(self):
        masked = wrapper_module._redacted(
            {"a": [SECRET, {"b": SECRET}], "n": 3, "s": "plain"}
        )

        assert SECRET not in json.dumps(masked)
        assert (masked["n"], masked["s"]) == (3, "plain")


class TestRecorder:
    def test_an_open_recording_lasts_until_now(self):
        recording = SessionRecording("s1", 100.0, None, {}, [])

        assert recording.duration() > 0
        assert SessionRecording("s1", 100.0, 103.5, {}, []).duration() == 3.5

    def test_stopping_a_session_that_was_not_recorded(self, tmp_path):
        assert SessionRecorder(tmp_path).stop_recording("ghost") is None

    def test_a_session_id_is_made_safe_for_a_file_name(self, tmp_path):
        recorder = SessionRecorder(tmp_path)
        recorder.start_recording("project:1/../x", {})

        recorder.stop_recording("project:1/../x")

        [saved] = list(tmp_path.iterdir())
        assert saved.name.endswith("_project_1_.._x.json")

    def test_a_failed_save_leaves_no_temporary_file(self, tmp_path, monkeypatch):
        recorder = SessionRecorder(tmp_path)
        recording = SessionRecording("s1", 1.0, 2.0, {}, [])

        def broken(*_args, **_kwargs):
            raise OSError("disk full")

        monkeypatch.setattr("streaming.session_recorder.json.dump", broken)
        with pytest.raises(OSError):
            recorder.save_recording(recording)
        assert list(tmp_path.iterdir()) == []

    def test_a_failed_save_whose_temporary_file_is_gone(self, tmp_path, monkeypatch):
        recorder = SessionRecorder(tmp_path)
        recording = SessionRecording("s1", 1.0, 2.0, {}, [])

        def vanish(source, _target):
            Path(source).unlink()
            raise OSError("disk full")

        monkeypatch.setattr("streaming.session_recorder.os.replace", vanish)
        with pytest.raises(OSError, match="disk full"):
            recorder.save_recording(recording)

    def test_an_unreadable_recording_is_skipped_in_the_list(self, tmp_path, caplog):
        recorder = SessionRecorder(tmp_path)
        recorder.save_recording(SessionRecording("good", 5.0, 6.0, {"t": 1}, []))
        (tmp_path / "broken.json").write_text("{", encoding="utf-8")
        (tmp_path / "partial.json").write_text("{}", encoding="utf-8")

        listed = recorder.list_recordings()

        assert [r["session_id"] for r in listed] == ["good"]
        assert caplog.text.count("Skipping unreadable recording") == 2

    async def test_a_replay_keeps_the_gaps_between_events(self, monkeypatch):
        waits: list[float] = []

        async def sleep(seconds):
            waits.append(seconds)

        monkeypatch.setattr("streaming.session_recorder.asyncio.sleep", sleep)
        recording = SessionRecording(
            "s1", 10.0, 20.0, {}, [_event(10.0), _event(12.0), _event(13.0)]
        )
        seen: list[float] = []

        async def callback(event):
            seen.append(event.timestamp)

        await SessionRecorder.replay_session(None, recording, 2.0, callback)
        await SessionRecorder.replay_session(None, recording, 1.0)

        assert waits == [0.0, 1.0, 0.5, 0.0, 2.0, 1.0]
        assert seen == [10.0, 12.0, 13.0]

    async def test_a_replay_needs_a_positive_speed(self):
        empty = SessionRecording("s1", 1.0, 1.0, {}, [])

        await SessionRecorder.replay_session(None, empty)
        with pytest.raises(ValueError):
            await SessionRecorder.replay_session(None, empty, speed=0)


class TestManager:
    async def test_broken_viewers_are_dropped_and_closed(self):
        manager = StreamingManager()
        await manager.start_session("s1", {})
        closed: list[int] = []

        class Viewer:
            def __init__(self, close):
                if close is not None:
                    self.close = close

            async def send(self, _payload):
                raise ConnectionError("gone")

        async def async_close(code):
            closed.append(code)

        def sync_close(code):
            closed.append(code)

        def failing_close(code):
            raise RuntimeError("already closed")

        viewers = [Viewer(c) for c in (async_close, sync_close, failing_close, None)]
        for viewer in viewers:
            manager.subscribe("s1", viewer)

        await manager.emit_chat_message("s1", "hi", "Ann")
        await asyncio.sleep(0)

        assert manager._subscribers["s1"] == set()
        assert sorted(closed) == [1011, 1011]

    async def test_a_session_that_ends_during_a_broadcast(self):
        manager = StreamingManager()

        class Leaving:
            async def send(self, _payload):
                del manager._subscribers["s1"]
                raise ConnectionError("gone")

        manager.subscribe("s1", Leaving())

        await manager.emit_chat_message("s1", "hi", "Ann")

        assert "s1" not in manager._subscribers

    async def test_controls_for_an_unknown_or_running_session_do_nothing(self):
        manager = StreamingManager()
        await manager.end_session("ghost")
        await manager.pause_session("ghost")
        await manager.resume_session("ghost")
        await manager.start_session("s1", {})

        await manager.resume_session("s1")

        assert manager.get_session_info("s1")["event_count"] == 1
        assert manager.get_session_info("ghost") is None


class TestRooms:
    def _ctx(self, channel="project:1", sub="u1", publish=False):
        return {
            "session_id": channel,
            "claims": {"sub": sub, "name": "  Ann   Lee "},
            "grant": SimpleNamespace(can_publish=publish),
        }

    @pytest.mark.parametrize(
        "ctx",
        [
            {"session_id": "project:1"},
            {"session_id": "run:1", "claims": {"sub": "u1"}, "grant": object()},
            {"session_id": "project:1", "claims": {"sub": ""}, "grant": object()},
            {
                "session_id": "project:1",
                "claims": {"sub": "service:x"},
                "grant": object(),
            },
        ],
    )
    def test_who_does_not_belong_in_a_room(self, ctx):
        assert ProjectRooms().member_of(ctx) is None

    def test_a_person_is_a_member_by_name(self):
        assert ProjectRooms().member_of(self._ctx()) == Member("u1", "Ann Lee")
        assert ProjectRooms().member_of(self._ctx(publish=True)) is None

    async def test_the_others_hear_who_leaves(self):
        rooms = ProjectRooms()
        staying, leaving = _Socket(), _Socket()
        rooms._rooms["project:1"] = {
            staying: Member("u1", "Ann"),
            leaving: Member("u2", "Bob"),
        }

        await rooms.leave("project:1", leaving)
        await rooms.leave("project:1", leaving)

        assert [e["data"] for e in staying.sent] == [
            {"users": [{"id": "u1", "name": "Ann"}]}
        ]
        assert leaving.sent == []

    def test_leaving_outside_an_event_loop_needs_no_announce(self):
        rooms = ProjectRooms()
        ws = object()
        rooms._rooms["project:1"] = {ws: Member("u1", "Ann")}

        rooms.leave_soon("project:1", ws)
        rooms.leave_soon("project:1", ws)

        assert rooms.roster("project:1") == []

    async def test_a_room_without_its_history_still_opens(self, monkeypatch):
        from server.services import team_chat

        async def unreachable(_project_id):
            raise OSError("database down")

        monkeypatch.setattr(team_chat, "recent_messages", unreachable)
        ws = _Socket()

        await ProjectRooms()._send_history("project:1", ws)

        assert ws.sent[0]["data"] == {"messages": []}

    async def test_a_stranger_cannot_write_in_the_room(self):
        rooms = ProjectRooms()
        ws = _Socket()

        await rooms.chat(self._ctx(), ws, {"message": "hi"}, allowed=True)

        assert ws.sent == []

    def test_old_messages_leave_the_rate_window(self, monkeypatch):
        rooms = ProjectRooms()
        ws = object()
        clock = iter([0.0, 0.1, 0.2, 0.3, 0.4, 10.0])
        monkeypatch.setattr(project_room.time, "monotonic", lambda: next(clock))

        assert all(rooms._allow(ws) for _ in range(5))
        assert rooms._allow(ws) is True
        assert len(rooms._sent[ws]) == 1

    def test_without_websockets_nor_sqlalchemy_the_errors_are_the_builtins(
        self, monkeypatch
    ):
        monkeypatch.setitem(sys.modules, "websockets.exceptions", None)
        monkeypatch.setitem(sys.modules, "sqlalchemy.exc", None)
        spec = importlib.util.spec_from_file_location(
            "streaming._room_probe", project_room.__file__
        )
        probe = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, spec.name, probe)
        spec.loader.exec_module(probe)

        assert probe._SEND_ERRORS == (OSError, RuntimeError)
        assert probe._STORE_ERRORS == (OSError, RuntimeError, ValueError)
