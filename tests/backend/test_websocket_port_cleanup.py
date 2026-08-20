"""The WS port cleanup must only ever touch processes bound to that port.

``kill_processes_on_port`` runs at every WebSocket-server start and walks the
whole process table. Its per-process filter used to end in a bare ``continue``,
so the connection check did nothing and every process fell through to the kill
decision — where ``_should_kill_process``'s "orphaned" rule (any python process
older than 5 minutes when port == 8765) matched unrelated interpreters.
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from streaming.websocket_server import _process_single_process  # noqa: E402

WS_PORT = 8765


class _Addr:
    def __init__(self, ip: str, port: int) -> None:
        self.ip = ip
        self.port = port


class _Conn:
    def __init__(self, ip: str, port: int, status: str = "LISTEN") -> None:
        self.laddr = _Addr(ip, port)
        self.status = status


class _FakeProc:
    """Minimal psutil.Process stand-in that records termination attempts."""

    def __init__(self, pid: int, name: str, conns: list[_Conn], age: float) -> None:
        self.info = {
            "pid": pid,
            "name": name,
            "cmdline": [name],
            "create_time": time.time() - age,
        }
        self._conns = conns
        self.terminated = False

    def connections(self):
        return self._conns

    def terminate(self):
        self.terminated = True

    def wait(self, timeout=None):
        return 0

    def is_running(self):
        return False


def test_unrelated_python_process_is_not_killed():
    """A long-lived python process with no socket on 8765 must survive."""
    victim = _FakeProc(4242, "python.exe", conns=[], age=3600)

    assert _process_single_process(victim, WS_PORT) is False
    assert victim.terminated is False


def test_process_listening_on_another_port_is_not_killed():
    other = _FakeProc(4243, "python.exe", conns=[_Conn("127.0.0.1", 9999)], age=3600)

    assert _process_single_process(other, WS_PORT) is False
    assert other.terminated is False


def test_stale_listener_on_the_target_port_is_killed():
    """The actual reason the function exists still works."""
    stale = _FakeProc(4244, "python.exe", conns=[_Conn("127.0.0.1", WS_PORT)], age=3600)

    assert _process_single_process(stale, WS_PORT) is True
    assert stale.terminated is True
