"""What ``pnpm dev`` does when the backend's port is already held.

``apps/backend/dev-port.mjs`` decides it, against real sockets here: uvicorn
alone fails the whole ``pnpm run dev`` with "[Errno 98] Address already in
use" (exit code 3). A WorkPilot backend already serving the port is reused;
any other program is named with the command that shows it.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
HELPER = REPO_ROOT / "apps" / "backend" / "dev-port.mjs"
DEV_SERVER = REPO_ROOT / "apps" / "backend" / "dev-server.mjs"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None, reason="node runs the dev launcher"
)


def _node(body: str, *args: str) -> dict:
    """Run ``body`` with the helper imported as ``dp``; it prints one JSON value."""
    script = f"import * as dp from {json.dumps(HELPER.as_uri())};\n{body}"
    node = shutil.which("node")
    assert node is not None
    out = subprocess.run(
        [node, "--input-type=module", "-e", script, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        timeout=60,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


def _handler(status: int, body: bytes) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args: object) -> None:
            return

    return Handler


@contextmanager
def _http(status: int, body: bytes, port: int = 0) -> Iterator[int]:
    server = ThreadingHTTPServer(("127.0.0.1", port), _handler(status, body))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()


def _workpilot(port: int = 0):
    return _http(200, b'{"status": "healthy", "subsystems": {}}', port)


def _not_workpilot():
    return _http(404, b'{"detail": "Not Found"}')


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _state(port: int) -> str:
    return _node(
        "console.log(JSON.stringify(await dp.devPortState('127.0.0.1', "
        "Number(process.argv[1]), { graceMs: 0 })));",
        str(port),
    )


def test_a_free_port_starts_the_backend() -> None:
    assert _state(_free_port()) == "free"


def test_a_workpilot_backend_on_the_port_is_reused() -> None:
    with _workpilot() as port:
        assert _state(port) == "workpilot"
        result = _node(
            "const lines = [];"
            "const r = await dp.checkDevPort({ port: Number(process.argv[1]),"
            " log: (m) => lines.push(m), error: (m) => lines.push(m) });"
            "console.log(JSON.stringify({ ...r, lines }));",
            str(port),
        )
    assert result["start"] is False
    assert result["exitCode"] == 0
    assert "already answers" in result["lines"][0]


def test_another_program_on_the_port_is_named_and_fails() -> None:
    with _not_workpilot() as port:
        assert _state(port) == "other"
        result = _node(
            "const lines = [];"
            "const state = (h, p) => dp.devPortState(h, p, { graceMs: 0 });"
            "const r = await dp.checkDevPort({ port: Number(process.argv[1]), state,"
            " log: (m) => lines.push(m), error: (m) => lines.push(m) });"
            "console.log(JSON.stringify({ ...r, lines }));",
            str(port),
        )
    assert (result["start"], result["exitCode"]) == (False, 1)
    assert len(result["lines"]) == 1
    assert f"Port {port} is already used" in result["lines"][0]


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (200, '{"status": "healthy"}', True),
        (200, '{"status": "degraded", "subsystems": {}}', True),
        (200, '{"status": "ok"}', False),
        (200, "null", False),
        (200, "<html>", False),
        (503, '{"status": "healthy"}', False),
    ],
)
def test_only_a_workpilot_health_verdict_counts(
    status: int, body: str, expected: bool
) -> None:
    assert (
        _node(
            "console.log(JSON.stringify(dp.isWorkPilotHealth("
            "Number(process.argv[1]), process.argv[2])));",
            str(status),
            body,
        )
        is expected
    )


@pytest.mark.parametrize(
    ("platform", "env", "expected"),
    [
        ("win32", {}, ["netstat -ano | findstr :9000", "taskkill /PID <pid> /F"]),
        ("darwin", {}, ["lsof -nP -iTCP:9000 -sTCP:LISTEN", "kill <pid>"]),
        ("linux", {}, ["ss -ltnp 'sport = :9000'", "kill <pid>"]),
        ("linux", {"WSL_DISTRO_NAME": "Ubuntu"}, ["in PowerShell"]),
    ],
)
def test_the_busy_port_message_gives_this_os_commands(
    platform: str, env: dict[str, str], expected: list[str]
) -> None:
    message = _node(
        "console.log(JSON.stringify(dp.portBusyMessage(9000, process.argv[1],"
        " JSON.parse(process.argv[2]))));",
        platform,
        json.dumps(env),
    )
    for command in expected:
        assert command in message
    if not env:
        assert "PowerShell" not in message


def _after_uvicorn(code: str, port: int) -> dict:
    return _node(
        "const lines = [];"
        "const code = JSON.parse(process.argv[1]);"
        "const r = await dp.exitCodeAfterUvicorn(code, { port: Number(process.argv[2]),"
        " log: (m) => lines.push(m), error: (m) => lines.push(m) });"
        "console.log(JSON.stringify({ code: r, lines }));",
        code,
        str(port),
    )


def test_uvicorn_losing_the_port_to_a_workpilot_backend_is_not_a_failure() -> None:
    with _workpilot() as port:
        result = _after_uvicorn("3", port)
    assert result["code"] == 0
    assert "already answers" in result["lines"][0]


def test_uvicorn_failing_on_a_free_port_keeps_its_code() -> None:
    assert _after_uvicorn("3", _free_port()) == {"code": 3, "lines": []}


def test_uvicorn_losing_the_port_to_another_program_says_so() -> None:
    with _not_workpilot() as port:
        result = _after_uvicorn("3", port)
    assert result["code"] == 3
    assert f"Port {port} is already used" in result["lines"][0]


def test_uvicorn_stopped_by_ctrl_c_exits_cleanly() -> None:
    assert _after_uvicorn("null", _free_port()) == {"code": 0, "lines": []}


def test_dev_server_reuses_a_running_backend_without_installing_anything() -> None:
    """The launcher itself, on its real port, when a WorkPilot backend holds it."""
    try:
        server = _workpilot(9000)
        port = server.__enter__()
    except OSError:
        pytest.skip("port 9000 is in use on this machine")
    try:
        node = shutil.which("node")
        assert node is not None
        out = subprocess.run(
            [node, str(DEV_SERVER)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
            cwd=DEV_SERVER.parent,
        )
    finally:
        server.__exit__(None, None, None)
    assert port == 9000
    assert out.returncode == 0, out.stderr
    assert "already answers on http://127.0.0.1:9000" in out.stdout
    assert "Creating Python venv" not in out.stdout
    assert "pip" not in out.stdout


# --- A port of its own when another program holds the default one -----------

DEV_RUN = REPO_ROOT / "scripts" / "dev.mjs"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("9001", 9001),
        (" 1024 ", 1024),
        ("65535", 65535),
        ("", None),
        ("80", None),
        ("65536", None),
        ("9000a", None),
        ("9e3", None),
    ],
)
def test_backend_port_accepts_only_a_user_port(raw: str, expected: int | None) -> None:
    assert (
        _node("console.log(JSON.stringify(dp.parsePort(process.argv[1])));", raw)
        == expected
    )


def _choose(states: dict[int, str], chosen: int | None = None) -> dict:
    return _node(
        "const states = JSON.parse(process.argv[1]);"
        "const asked = [];"
        "const state = async (_h, p) => { asked.push(p); return states[p] ?? 'free'; };"
        "const chosen = JSON.parse(process.argv[2]);"
        "const r = await dp.chooseDevPort({ chosen, state });"
        "console.log(JSON.stringify({ r, asked }));",
        json.dumps({str(k): v for k, v in states.items()}),
        json.dumps(chosen),
    )


def test_the_default_port_is_kept_when_free_or_a_workpilot_backend() -> None:
    assert _choose({}) == {"r": {"port": 9000}, "asked": [9000]}
    assert _choose({9000: "workpilot"})["r"] == {"port": 9000}


def test_another_program_on_the_default_port_moves_the_backend_on() -> None:
    result = _choose({9000: "other", 9001: "other"})
    assert result == {
        "r": {"port": 9002, "movedFrom": 9000},
        "asked": [9000, 9001, 9002],
    }
    assert _choose({9000: "other", 9001: "workpilot"})["r"] == {
        "port": 9001,
        "movedFrom": 9000,
    }


def test_a_port_the_user_chose_is_kept_without_looking() -> None:
    assert _choose({9100: "other"}, chosen=9100) == {"r": {"port": 9100}, "asked": []}


def test_no_free_port_in_the_span_is_reported() -> None:
    states = dict.fromkeys(range(9000, 9021), "other")
    assert _choose(states)["r"] is None


def test_the_messages_name_the_ports() -> None:
    moved = _node("console.log(JSON.stringify(dp.movedPortMessage(9000, 9001)));")
    assert "Port 9000" in moved
    assert "port 9001" in moved
    assert "BACKEND_PORT" in moved
    assert "9000 to 9020" in _node(
        "console.log(JSON.stringify(dp.noFreePortMessage()));"
    )
    assert '"abc"' in _node(
        "console.log(JSON.stringify(dp.invalidPortMessage('abc')));"
    )


def test_dev_server_moves_off_a_default_port_another_program_holds() -> None:
    """The launcher alone, on its real ports: 9000 taken, the next one serves."""
    try:
        foreign = _not_workpilot_on(9000)
        foreign.__enter__()
    except OSError:
        pytest.skip("port 9000 is in use on this machine")
    try:
        try:
            backend = _workpilot(9001)
            backend.__enter__()
        except OSError:
            pytest.skip("port 9001 is in use on this machine")
        try:
            node = shutil.which("node")
            assert node is not None
            env = {k: v for k, v in os.environ.items() if k != "BACKEND_PORT"}
            out = subprocess.run(
                [node, str(DEV_SERVER)],
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=90,
                cwd=DEV_SERVER.parent,
                env=env,
            )
        finally:
            backend.__exit__(None, None, None)
    finally:
        foreign.__exit__(None, None, None)
    assert out.returncode == 0, out.stderr
    assert "this run uses port 9001" in out.stdout
    assert "already answers on http://127.0.0.1:9001" in out.stdout


def _not_workpilot_on(port: int):
    return _http(404, b'{"detail": "Not Found"}', port)


def _dev_run(body: str, *args: str) -> dict:
    script = f"import * as dev from {json.dumps(DEV_RUN.as_uri())};\n{body}"
    node = shutil.which("node")
    assert node is not None
    out = subprocess.run(
        [node, "--input-type=module", "-e", script, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        timeout=60,
        cwd=REPO_ROOT,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("BACKEND_PORT=9100\n", "9100"),
        ("# BACKEND_PORT=1\n BACKEND_PORT = 9 \nBACKEND_PORT='9200'\r\n", "9200"),
        ('OTHER=1\nBACKEND_PORT="9300"', "9300"),
        ("#BACKEND_PORT=9000\n", None),
    ],
)
def test_the_dev_run_reads_backend_port_from_the_env_file(
    text: str, expected: str | None
) -> None:
    assert (
        _dev_run(
            "console.log(JSON.stringify(dev.envFilePort(process.argv[1]) ?? null));",
            text,
        )
        == expected
    )


def test_the_dev_run_says_why_it_moved_and_hands_the_port_on() -> None:
    result = _dev_run(
        "const choose = async () => ({ port: 9001, movedFrom: 9000 });"
        "console.log(JSON.stringify(await dev.devRunPort({ raw: undefined, choose })));"
    )
    assert result["port"] == 9001
    assert "this run uses port 9001" in result["lines"][0]


def test_the_dev_run_ignores_a_bad_backend_port_and_says_so() -> None:
    result = _dev_run(
        "let seen;"
        "const choose = async ({ chosen }) => { seen = chosen; return { port: 9000 }; };"
        "const r = await dev.devRunPort({ raw: 'abc', choose });"
        "console.log(JSON.stringify({ ...r, seen }));"
    )
    assert result["seen"] is None
    assert result["port"] == 9000
    assert "is not a port" in result["lines"][0]


def test_the_dev_run_stops_when_no_port_is_left() -> None:
    result = _dev_run(
        "const choose = async () => null;"
        "console.log(JSON.stringify(await dev.devRunPort({ raw: '9100', choose })));"
    )
    assert result["port"] is None
    assert "are all used" in result["lines"][-1]
