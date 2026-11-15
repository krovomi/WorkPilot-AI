"""The streaming WebSocket server over real sockets, as the app and the agents use it.

Each test starts the real server on a free local port and talks to it with the
``websockets`` client: the handshake (allowed and refused origins), the welcome,
a channel switch, an agent's event reaching the viewers, chat and controls. The
process-table cleanup at start-up runs against stand-in processes.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import socket
import time
from types import SimpleNamespace

import psutil
import pytest
import websockets
from streaming import websocket_server as ws_server
from streaming.streaming_manager import StreamingManager


def _free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


@contextlib.asynccontextmanager
async def _running():
    server = ws_server.StreamingWebSocketServer("127.0.0.1", _free_port())
    server.streaming_manager = StreamingManager()
    await server.start()
    try:
        yield server
    finally:
        await server.stop()


def _url(server, channel: str = "s1") -> str:
    return f"ws://127.0.0.1:{server.port}/stream/{channel}"


async def _next(ws, kind: str) -> dict:
    """The next event of type `kind`, skipping the others."""
    while True:
        event = json.loads(await asyncio.wait_for(ws.recv(), 5))
        if event["event_type"] == kind:
            return event


async def _until(predicate) -> None:
    for _ in range(200):
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition never met")


class TestHandshake:
    async def test_a_page_from_another_origin_is_refused_with_403(self):
        async with _running() as server:
            with pytest.raises(websockets.exceptions.InvalidStatus) as refused:
                await websockets.connect(_url(server), origin="http://evil.example")

        assert refused.value.response.status_code == 403

    async def test_the_app_and_an_agent_are_welcomed(self):
        async with _running() as server:
            async with websockets.connect(
                _url(server), origin="http://localhost:5173"
            ) as app:
                welcome = await _next(app, "session_start")
            async with websockets.connect(_url(server, "s2")) as agent:
                second = await _next(agent, "session_start")

        assert welcome["data"]["session_id"] == "s1"
        assert second["data"] == {
            "session_id": "s2",
            "message": "Connected to streaming session",
            "auto_created": False,
        }

    async def test_a_path_without_a_channel_gets_one_of_its_own(self):
        async with _running() as server:
            async with websockets.connect(
                f"ws://127.0.0.1:{server.port}/elsewhere"
            ) as ws:
                welcome = await _next(ws, "session_start")

        assert welcome["session_id"].startswith("session-")


class TestMessages:
    async def test_an_agent_event_reaches_the_viewers_but_not_its_sender(self):
        async with _running() as server:
            async with (
                websockets.connect(_url(server)) as viewer,
                websockets.connect(_url(server, "other")) as agent,
            ):
                await _next(viewer, "session_start")
                await _next(agent, "session_start")
                await agent.send(
                    json.dumps({"type": "init_session", "session_id": "s1"})
                )
                confirmed = await _next(agent, "session_confirmed")
                await agent.send(
                    json.dumps(
                        {
                            "type": "agent_event",
                            "event": {
                                "event_type": "tool_use",
                                "timestamp": 1.0,
                                "data": {"tool_name": "Read"},
                                "session_id": "s1",
                            },
                        }
                    )
                )
                seen = await _next(viewer, "tool_use")
                await agent.send(json.dumps({"type": "ping"}))
                await agent.send(json.dumps({"type": "chat_message", "message": "hi"}))
                echoed = await _next(agent, "chat_message")

        assert confirmed["data"]["session_id"] == "s1"
        assert (seen["data"], seen["timestamp"]) == ({"tool_name": "Read"}, 1.0)
        assert (echoed["data"]["message"], echoed["data"]["author"]) == ("hi", "User")

    @pytest.mark.parametrize(
        "raw",
        [
            "not json",
            json.dumps(["a list"]),
            json.dumps({"type": "agent_event"}),
            json.dumps({"type": "agent_event", "event": {"event_type": "teleport"}}),
            json.dumps({"type": "init_session", "session_id": "s1"}),
        ],
    )
    async def test_a_message_that_is_not_one_is_dropped(self, raw):
        async with _running() as server:
            async with websockets.connect(_url(server)) as ws:
                await _next(ws, "session_start")
                await ws.send(raw)
                await ws.send(json.dumps({"type": "chat_message", "message": "after"}))
                after = await _next(ws, "chat_message")

        assert after["data"]["message"] == "after"

    async def test_pause_resume_and_stop(self):
        async with _running() as server:
            manager = server.streaming_manager
            async with websockets.connect(_url(server)) as ws:
                await _next(ws, "session_start")

                async def control(action: str) -> None:
                    await ws.send(json.dumps({"type": "control", "action": action}))

                await control("toggle_pause")
                paused = await _next(ws, "progress_update")
                await control("toggle_pause")
                resumed = await _next(ws, "progress_update")
                await control("dance")
                await control("stop")
                await _next(ws, "session_end")

        assert (paused["data"]["is_paused"], resumed["data"]["is_paused"]) == (
            True,
            False,
        )
        assert manager.get_session_info("s1")["status"] == "completed"

    async def test_a_viewer_who_leaves_is_forgotten(self):
        async with _running() as server:
            async with websockets.connect(_url(server)) as ws:
                await _next(ws, "session_start")
                assert len(server._clients["s1"]) == 1
            await _until(lambda: not server._clients["s1"])

            assert server.streaming_manager._subscribers["s1"] == set()

    async def test_an_error_while_handling_a_client_still_cleans_it_up(
        self, monkeypatch
    ):
        async with _running() as server:

            async def broken(*_args):
                raise RuntimeError("boom")

            monkeypatch.setattr(server, "_handle_client_messages", broken)
            async with websockets.connect(_url(server)) as ws:
                await _next(ws, "session_start")
                await _until(lambda: not server._clients["s1"])


class TestUnits:
    async def test_a_subscriber_that_fails_is_dropped(self):
        server = ws_server.StreamingWebSocketServer()
        server.streaming_manager = StreamingManager()

        class Gone:
            async def send(self, _raw):
                raise ConnectionError("gone")

        gone = Gone()
        server._clients["s1"] = {gone}
        event = SimpleNamespace(to_dict=lambda: {"event_type": "x"})

        await server._broadcast_to_subscribers("s1", event)

        assert server._clients["s1"] == set()

    async def test_a_control_for_a_session_that_does_not_exist_is_ignored(self):
        server = ws_server.StreamingWebSocketServer()
        server.streaming_manager = StreamingManager()

        await server._handle_control("ghost", "toggle_pause")

        assert server.streaming_manager.get_session_info("ghost") is None

    async def test_a_welcome_that_cannot_be_sent_is_only_logged(self, caplog):
        server = ws_server.StreamingWebSocketServer()

        class Closed:
            async def send(self, _raw):
                raise ConnectionError("closed")

        await server._send_welcome_message("s1", Closed(), None)

        assert "Failed to send welcome message" in caplog.text

    async def test_a_connection_lost_mid_stream_ends_its_loop(self, caplog):
        server = ws_server.StreamingWebSocketServer()

        class Dropped:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise websockets.exceptions.ConnectionClosedError(None, None)

        caplog.set_level(logging.INFO, logger=ws_server.__name__)

        await server._handle_client_messages(Dropped(), {"session_id": "s1"})

        assert "Client left session s1" in caplog.text

    async def test_a_message_whose_handling_fails_is_only_logged(
        self, monkeypatch, caplog
    ):
        server = ws_server.StreamingWebSocketServer()
        server.streaming_manager = StreamingManager()

        async def broken(_session_id):
            raise RuntimeError("store down")

        monkeypatch.setattr(server.streaming_manager, "end_session", broken)

        await server._handle_message(
            {"session_id": "s1"},
            object(),
            json.dumps({"type": "control", "action": "stop"}),
        )

        assert "Error handling message: store down" in caplog.text

    def test_the_active_sessions_come_from_the_manager(self):
        server = ws_server.StreamingWebSocketServer()
        server.streaming_manager = StreamingManager()

        assert server.get_active_sessions() == []

    async def test_the_global_server_starts_and_stops_once(self, monkeypatch):
        calls: list[str] = []

        class Recorder:
            async def start(self):
                calls.append("start")

            async def stop(self):
                calls.append("stop")

        monkeypatch.setattr(ws_server, "_websocket_server", None)
        first = ws_server.get_websocket_server()
        assert ws_server.get_websocket_server() is first
        monkeypatch.setattr(ws_server, "_websocket_server", Recorder())

        await ws_server.start_streaming_server()
        await ws_server.stop_streaming_server()

        assert calls == ["start", "stop"]


class TestStart:
    async def test_a_port_that_cannot_be_freed_keeps_the_server_down(self, monkeypatch):
        monkeypatch.setattr(ws_server, "kill_processes_on_port", lambda _port: False)
        server = ws_server.StreamingWebSocketServer("127.0.0.1", _free_port())

        await server.start()
        await server.stop()

        assert server._server is None

    async def test_a_failure_to_listen_is_logged(self, monkeypatch, caplog):
        async def refuse(*_args, **_kwargs):
            raise OSError("address in use")

        monkeypatch.setattr(ws_server.websockets, "serve", refuse)
        server = ws_server.StreamingWebSocketServer("127.0.0.1", _free_port())

        await server.start()

        assert server._server is None
        assert "Failed to start WebSocket server" in caplog.text


class TestServerModeHelpers:
    def test_unbuildable_settings_fall_back_on_the_environment(self, monkeypatch):
        from server import config as server_config

        def broken():
            raise ValueError("no secret")

        monkeypatch.setattr(server_config, "get_settings", broken)
        monkeypatch.setenv("WORKPILOT_SERVER_MODE", " Yes ")

        assert ws_server._server_mode_enabled() is True

    def test_a_token_that_does_not_decode_is_refused(self, monkeypatch):
        from server.auth import jwt_tokens

        def explode(_token):
            raise RuntimeError("settings unavailable")

        assert ws_server._validate_ws_token("not-a-token") is None
        monkeypatch.setattr(jwt_tokens, "decode_access_token", explode)
        assert ws_server._validate_ws_token("x") is None

    async def test_a_channel_check_that_cannot_run_refuses(self, monkeypatch):
        import sys

        server = ws_server.StreamingWebSocketServer()
        ctx = {"claims": {"sub": "u1"}}

        monkeypatch.setitem(sys.modules, "server.authz.ws_channels", None)
        assert await server._authorize_channel(ctx, "project:1") is None
        monkeypatch.delitem(sys.modules, "server.authz.ws_channels")

        from server.db import engine

        def no_database():
            raise RuntimeError("database not configured")

        monkeypatch.setattr(engine, "get_session_factory", no_database)
        assert await server._authorize_channel(ctx, "project:1") is None

    async def test_a_refused_channel_switch_keeps_the_channel(self, monkeypatch):
        server = ws_server.StreamingWebSocketServer()

        async def refuse(_ctx, _channel):
            return None

        monkeypatch.setattr(server, "_authorize_channel", refuse)
        ctx = {"session_id": "project:1", "claims": {"sub": "u1"}}

        await server._handle_init_session(ctx, object(), {"session_id": "project:2"})

        assert ctx["session_id"] == "project:1"

    async def test_a_granted_channel_switch_moves_the_connection(self, monkeypatch):
        server = ws_server.StreamingWebSocketServer()
        server.streaming_manager = StreamingManager()
        grant = SimpleNamespace(can_publish=True)

        async def allow(_ctx, _channel):
            return grant

        class Socket:
            sent: list[dict] = []

            async def send(self, raw):
                self.sent.append(json.loads(raw))

        monkeypatch.setattr(server, "_authorize_channel", allow)
        ws = Socket()
        ctx = {"session_id": "run:1", "claims": {"sub": "service:run"}}

        await server._handle_init_session(ctx, ws, {"session_id": "run:2"})

        assert (ctx["session_id"], ctx["grant"]) == ("run:2", grant)
        assert ws in server._clients["run:2"]
        assert ws.sent[-1]["event_type"] == "session_confirmed"


class TestPortCleanup:
    class _Proc:
        def __init__(self, waits: list, running: bool = True) -> None:
            self.waits = waits
            self.running = running
            self.calls: list[str] = []

        def terminate(self):
            self.calls.append("terminate")

        def wait(self, timeout=None):
            outcome = self.waits.pop(0)
            if outcome is not None:
                raise outcome
            return 0

        def is_running(self):
            return self.running

        def kill(self):
            self.calls.append("kill")

    def test_a_process_that_ends_on_request_is_not_killed(self):
        proc = self._Proc([None])

        ws_server._kill_process_safely(proc, 1, "python")

        assert proc.calls == ["terminate"]

    def test_a_process_already_gone_is_left_alone(self):
        proc = self._Proc([psutil.NoSuchProcess(1)])

        ws_server._kill_process_safely(proc, 1, "python")

        assert proc.calls == ["terminate"]

    def test_a_process_that_hangs_is_killed(self):
        proc = self._Proc([psutil.TimeoutExpired(1), psutil.TimeoutExpired(2)])

        ws_server._kill_process_safely(proc, 1, "python")

        assert proc.calls == ["terminate", "kill"]

    def test_a_process_that_ended_while_waiting_is_not_killed(self):
        proc = self._Proc([psutil.TimeoutExpired(1)], running=False)

        ws_server._kill_process_safely(proc, 1, "python")

        assert proc.calls == ["terminate"]

    @pytest.mark.parametrize(
        ("cmdline", "name", "age", "expected"),
        [
            (["python", "websocket_server.py"], "python", 60, True),
            (["node", "app.js"], "python3", 400, True),
            (["node", "app.js"], "node", 400, False),
        ],
    )
    def test_which_listener_is_stale(self, cmdline, name, age, expected):
        kill, reason = ws_server._should_kill_process(
            1, name, cmdline, time.time() - age, 8765
        )

        assert kill is expected
        assert reason

    def test_our_own_process_is_never_killed(self):
        import os

        assert (
            ws_server._should_kill_process(os.getpid(), "python", [], 0, 8765)[0]
            is False
        )

    def test_a_young_listener_on_the_port_is_preserved(self):
        listener = SimpleNamespace(
            status="LISTEN", laddr=SimpleNamespace(ip="127.0.0.1", port=8765)
        )
        proc = SimpleNamespace(
            connections=lambda: [listener],
            info={
                "pid": 1,
                "name": "node",
                "cmdline": ["node"],
                "create_time": time.time(),
            },
        )

        assert ws_server._process_single_process(proc, 8765) is False

    def test_a_process_that_vanishes_while_read_is_skipped(self):
        class Vanishing:
            def connections(self):
                raise psutil.AccessDenied(1)

        assert ws_server._process_single_process(Vanishing(), 8765) is False

    def test_a_free_port_needs_no_cleanup(self, monkeypatch):
        port = _free_port()

        assert ws_server._is_port_available(port) is True
        assert ws_server.kill_processes_on_port(port) is True

    def test_an_occupied_port_is_freed_or_kept(self, monkeypatch):
        killed = iter([False, True])
        monkeypatch.setattr(ws_server, "_is_port_available", lambda _p: next(occupied))
        monkeypatch.setattr(ws_server.time, "sleep", lambda _s: None)
        monkeypatch.setattr(
            ws_server, "_process_single_process", lambda _proc, _port: next(killed)
        )
        monkeypatch.setattr(ws_server.psutil, "process_iter", lambda _attrs: [object()])

        # Nobody to kill: the listener is preserved.
        occupied = iter([False])
        assert ws_server.kill_processes_on_port(9) is True
        # A stale listener killed, and the port is then free.
        occupied = iter([False, True])
        assert ws_server.kill_processes_on_port(9) is True

    def test_a_port_still_held_after_the_cleanup_is_reported(self, monkeypatch):
        monkeypatch.setattr(ws_server, "_is_port_available", lambda _p: False)
        monkeypatch.setattr(ws_server.time, "sleep", lambda _s: None)
        monkeypatch.setattr(
            ws_server, "_process_single_process", lambda _proc, _port: True
        )
        monkeypatch.setattr(ws_server.psutil, "process_iter", lambda _attrs: [object()])

        assert ws_server.kill_processes_on_port(9) is False

    def test_a_process_table_that_cannot_be_read_is_a_failure(self, monkeypatch):
        def denied(_attrs):
            raise psutil.AccessDenied(0)

        monkeypatch.setattr(ws_server, "_is_port_available", lambda _p: False)
        monkeypatch.setattr(ws_server.psutil, "process_iter", denied)

        assert ws_server.kill_processes_on_port(9) is False
