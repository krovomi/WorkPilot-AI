"""The loopback door inside a Linux sandbox, run in this process.

Inside the sandbox `bridge.py` runs under `bwrap`, where coverage cannot follow
it; here it runs as a function, with a real Unix socket standing in for the
filtering proxy and a real child process standing in for the agent. Unix
sockets and `SIGHUP` are POSIX: the bridge only ever runs on Linux, and these
tests run where it can.
"""

from __future__ import annotations

import runpy
import socket
import sys
import threading
from pathlib import Path

import pytest
from foundation.platform import is_windows
from os_sandbox import bridge

pytestmark = pytest.mark.skipif(
    is_windows(), reason="the bridge runs inside a Linux sandbox only"
)


def _free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


@pytest.fixture
def proxy(socket_dir):
    """A Unix socket that answers each connection with what it read, upper-cased."""
    path = str(socket_dir / "proxy.sock")
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen(4)

    def serve():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            with conn:
                data = b""
                while not data.endswith(b"\n"):
                    chunk = conn.recv(1024)
                    if not chunk:
                        break
                    data += chunk
                conn.sendall(data.upper())

    threading.Thread(target=serve, daemon=True).start()
    yield path
    server.close()


@pytest.fixture
def handlers(monkeypatch):
    """The signal handlers the bridge installs, kept off this test process."""
    installed: dict[int, object] = {}
    monkeypatch.setattr(
        bridge.signal,
        "signal",
        lambda signum, handler: installed.update({signum: handler}),
    )
    return installed


def _client_script(port: int, exit_code: int) -> list[str]:
    """A child that talks through the bridge and exits with what it heard."""
    code = (
        "import socket, sys\n"
        f"s = socket.create_connection(('127.0.0.1', {port}), timeout=10)\n"
        "s.sendall(b'ping\\n')\n"
        "reply = b''\n"
        "while True:\n"
        "    try: chunk = s.recv(1024)\n"
        "    except OSError: break  # a reset is no reply too\n"
        "    if not chunk: break\n"
        "    reply += chunk\n"
        f"sys.exit({exit_code} if reply == b'PING\\n' else 99)\n"
    )
    return [sys.executable, "-I", "-c", code]


def test_the_command_reaches_the_proxy_through_loopback(proxy, handlers):
    port = _free_port()

    code = bridge.main([proxy, str(port), "--", *_client_script(port, 7)])

    assert code == 7
    assert set(handlers) == {
        bridge.signal.SIGTERM,
        bridge.signal.SIGINT,
        bridge.signal.SIGHUP,
    }


def test_a_signal_to_the_bridge_is_passed_to_the_command(proxy, handlers, monkeypatch):
    port = _free_port()
    sent = []

    class Recording(bridge.subprocess.Popen):  # type: ignore[misc]
        def send_signal(self, sig):
            sent.append(sig)

    monkeypatch.setattr(bridge.subprocess, "Popen", Recording)
    bridge.main([proxy, str(port), "--", *_client_script(port, 0)])

    handlers[bridge.signal.SIGTERM](bridge.signal.SIGTERM, None)

    assert sent == [bridge.signal.SIGTERM]


def test_a_command_killed_by_a_signal_exits_the_shell_way(proxy, handlers):
    port = _free_port()
    kill_self = [
        sys.executable,
        "-I",
        "-c",
        "import os, signal; os.kill(os.getpid(), signal.SIGTERM)",
    ]

    assert bridge.main([proxy, str(port), "--", *kill_self]) == 128 + 15


@pytest.mark.parametrize(
    "argv",
    [
        [],
        ["sock", "8080", "cmd"],
        ["sock", "8080", "-", "cmd"],
        ["sock", "not-a-port", "--", "cmd"],
        ["sock", "99999", "--", "cmd"],
    ],
)
def test_a_malformed_invocation_is_refused_before_anything_runs(argv, handlers):
    assert bridge.main(argv) == 126
    assert handlers == {}


def test_a_command_that_cannot_start_exits_127(proxy, handlers, tmp_path):
    missing = str(tmp_path / "no-such-agent")

    assert bridge.main([proxy, str(_free_port()), "--", missing]) == 127


def test_a_missing_proxy_closes_the_connection(tmp_path, handlers):
    port = _free_port()
    gone = str(tmp_path / "gone.sock")

    # The child hears nothing back and exits 99.
    assert bridge.main([gone, str(port), "--", *_client_script(port, 0)]) == 99


def test_a_closed_listener_ends_the_serving_loop(tmp_path):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.close()

    assert bridge._serve(listener, str(tmp_path / "proxy.sock")) is None


class _Broken:
    """A socket whose every call fails, as one whose peer vanished."""

    def __init__(self):
        self.calls = []

    def recv(self, _size):
        self.calls.append("recv")
        raise ConnectionResetError

    def shutdown(self, _how):
        self.calls.append("shutdown")
        raise OSError("not connected")


def test_a_peer_that_vanishes_stops_the_relay_quietly():
    source, target = _Broken(), _Broken()

    bridge._relay(source, target)  # type: ignore[arg-type]

    assert source.calls == ["recv"] and target.calls == ["shutdown"]


def test_the_bridge_module_is_the_file_the_launcher_starts():
    from os_sandbox import launch

    assert Path(bridge.__file__).resolve() == launch._BRIDGE.resolve()


def test_run_as_a_script_it_exits_with_its_code(monkeypatch):
    """How `bwrap` starts it: `python -I bridge.py <socket> <port> -- <command>`."""
    monkeypatch.setattr(sys, "argv", [bridge.__file__, "sock", "port"])

    with pytest.raises(SystemExit) as stopped:
        runpy.run_path(bridge.__file__, run_name="__main__")

    assert stopped.value.code == 126
