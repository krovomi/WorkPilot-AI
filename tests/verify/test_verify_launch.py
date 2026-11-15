"""`verify.launch` with real processes: a small Python app per answer.

Each app is a script in the project, started by the launch itself in its own
process group: one serves HTTP on the port it is given, one announces another
port in its log, one dies, one never answers, one answers 500. Nothing below
the process is mocked.
"""

from __future__ import annotations

import http.server
import sys
import threading
from pathlib import Path

import pytest
from verify.detect import Target
from verify.launch import _log_path, launch, probe, read_log
from verify.state import live_process, load_state, stop_all, work_dir

SERVE = """import http.server, os, sys
port = int(sys.argv[1])
status = int(os.environ.get("ANSWER", "200"))
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(status)
        self.end_headers()
        self.wfile.write(b"ok")
    def log_message(self, *a):
        pass
print("port env", os.environ.get("APP_PORT"), "extra", os.environ.get("EXTRA"), flush=True)
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
"""

# Binds a port of its own choosing and says so, the way Vite does when its
# default port is taken.
ANNOUNCE = """import http.server
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404)
        self.end_headers()
    def log_message(self, *a):
        pass
server = http.server.HTTPServer(("127.0.0.1", 0), H)
print(f"  Local:   http://localhost:{server.server_port}/", flush=True)
server.serve_forever()
"""

DIES = """import sys
print("Traceback (most recent call last):", flush=True)
print('  File "main.py", line 3, in <module>', flush=True)
print("KeyError: 'ORDERS_DB'", flush=True)
sys.exit(3)
"""

QUIET_EXIT = "import sys\nsys.exit(4)\n"

SILENT = "import time\ntime.sleep(60)\n"

ARGS = "import sys\nprint('args', sys.argv[1:], flush=True)\n"


def _python(script: str, *args: str) -> str:
    return " ".join([f'"{sys.executable}"', script, *args])


@pytest.fixture
def project(tmp_path):
    root = tmp_path / "shop"
    root.mkdir()
    for name, text in {
        "serve.py": SERVE,
        "announce.py": ANNOUNCE,
        "dies.py": DIES,
        "quiet_exit.py": QUIET_EXIT,
        "silent.py": SILENT,
        "args.py": ARGS,
    }.items():
        (root / name).write_text(text, encoding="utf-8")
    base = work_dir(root, None)
    yield root, base
    stop_all(base)


def _api(command: str, **extra) -> Target:
    return Target(kind="backend-api", name="api", command=command, **extra)


# -- probe -------------------------------------------------------------------


def test_probe_answers_only_for_loopback():
    assert probe("http://example.com/") is None
    assert probe("http://10.0.0.5:8080/") is None
    assert probe("http://127.0.0.1.evil.example/") is None
    # Nothing listens there.
    assert probe("http://127.0.0.1:9/", timeout=0.5) is None


def test_probe_gives_the_status_of_an_error_answer():
    class Missing(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server's name
            self.send_response(404)
            self.end_headers()

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Missing)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        assert probe(f"http://127.0.0.1:{server.server_port}/x") == 404
    finally:
        server.shutdown()


def test_read_log_keeps_the_tail_and_a_missing_log_is_empty(tmp_path):
    log = tmp_path / "app.log"
    log.write_bytes(b"a" * 10 + b"tail\xff")
    assert read_log(log, tail_bytes=5) == "tail�"
    assert read_log(tmp_path / "none.log") == ""


def test_a_log_name_is_a_safe_file_name(tmp_path):
    escaped = _log_path(tmp_path, "../web app")
    assert escaped.parent == tmp_path / "logs" and escaped.name == "..-web-app.log"
    assert _log_path(tmp_path, "///").name == "app.log"


# -- refusals ----------------------------------------------------------------


def test_what_cannot_be_launched_is_refused(project):
    root, base = project
    mobile = launch(Target(kind="mobile", name="phone"), root, base)
    assert (mobile.status, mobile.detail) == (
        "refused",
        "mobile targets launch through verify.mobile",
    )
    nothing = launch(_api("   "), root, base)
    assert (nothing.status, nothing.detail) == ("refused", "no launch command detected")
    escapes = launch(
        _api(_python("serve.py", "{port}"), root="../elsewhere"), root, base
    )
    assert (escapes.status, escapes.detail) == (
        "refused",
        "target root escapes the project",
    )
    missing = launch(_api(_python("serve.py", "{port}"), root="web"), root, base)
    assert (missing.status, missing.detail) == ("refused", "web is not a directory")
    assert not mobile.ok and load_state(base)["processes"] == {}


def test_a_log_that_cannot_be_written_refuses_the_launch(project):
    root, base = project
    # A folder where the log file goes.
    (base / "logs" / "api.log").mkdir(parents=True)
    result = launch(_api(_python("serve.py", "{port}")), root, base)
    assert result.status == "refused"
    assert result.detail.startswith("cannot write the log:")


def test_a_command_that_cannot_start_says_so(project):
    root, base = project
    result = launch(_api("no-such-program-for-verify --port {port}"), root, base)
    assert result.status == "exited"
    assert result.detail.startswith("could not start:")
    assert [e.kind for e in result.errors] == ["launch"]
    assert load_state(base)["processes"] == {}


# -- what the app does -------------------------------------------------------


def test_an_app_that_dies_is_exited_with_what_it_printed(project):
    root, base = project
    result = launch(_api(_python("dies.py")), root, base, timeout=20)
    assert (result.status, result.exit_code) == ("exited", 3)
    assert result.detail == "exited with code 3 before answering"
    assert "KeyError: 'ORDERS_DB'" in result.log_tail
    assert result.errors and result.errors[0].kind != "crash"
    assert live_process(base, "api") is None


def test_an_app_that_dies_silently_is_a_crash(project):
    root, base = project
    result = launch(_api(_python("quiet_exit.py")), root, base, timeout=20)
    assert result.exit_code == 4
    assert [(e.kind, e.message) for e in result.errors] == [
        ("crash", "the process exited with code 4")
    ]


def test_an_app_that_never_answers_times_out_and_is_stopped(project):
    root, base = project
    result = launch(_api(_python("silent.py"), port=0), root, base, timeout=1.5)
    assert result.status == "timeout"
    assert result.detail.startswith("nothing answered on http://127.0.0.1:")
    assert result.detail.endswith("within 1s")
    assert live_process(base, "api") is None


def test_an_app_on_its_port_is_ready_then_reused_then_restarted(project):
    root, base = project
    target = _api(
        _python("serve.py", "{port}"),
        port_env=["APP_PORT"],
        env={"EXTRA": "on-{port}"},
    )

    first = launch(target, root, base, timeout=30)

    assert first.status == "ready", first.log_tail
    port = first.url.rsplit(":", 1)[1]
    assert first.command.endswith(f"serve.py {port}")
    assert f"port env {port} extra on-{port}" in first.log_tail
    assert first.ok and first.pid
    assert first.errors == []
    assert live_process(base, "api")["url"] == first.url

    again = launch(target, root, base)
    assert (again.status, again.url, again.pid) == ("reused", first.url, first.pid)

    restarted = launch(target, root, base, timeout=30, restart=True)
    assert restarted.status == "ready"
    assert restarted.pid != first.pid
    data = first.to_dict()
    assert data["status"] == "ready" and data["errors"] == []


def test_a_recorded_app_that_stopped_answering_is_launched_again(project):
    root, base = project
    target = _api(_python("serve.py", "{port}"))
    first = launch(target, root, base, timeout=30)
    assert first.status == "ready"
    # The process lives on but its URL no longer answers.
    from verify.state import save_process

    entry = live_process(base, "api")
    save_process(base, "api", {**entry, "url": "http://127.0.0.1:9"})

    second = launch(target, root, base, timeout=30)
    assert second.status == "ready"
    assert second.pid != first.pid


def test_the_url_an_app_prints_is_believed(project):
    root, base = project
    result = launch(_api(_python("announce.py")), root, base, timeout=30)
    assert result.status == "ready", result.log_tail
    assert result.url.startswith("http://127.0.0.1:")
    # A 404 on `/` is an app that is up, not an error.
    assert result.errors == []


def test_a_ready_path_that_answers_500_is_an_error(project, monkeypatch):
    root, base = project
    monkeypatch.setenv("ANSWER", "500")
    result = launch(
        _api(_python("serve.py", "{port}"), ready_path="health"), root, base, timeout=30
    )
    assert result.status == "ready"
    assert [(e.kind, e.message) for e in result.errors] == [
        ("http", "GET / answered 500")
    ]


def test_an_electron_app_gets_its_debugging_port(project):
    root, base = project
    target = Target(kind="desktop", name="desk", command=_python("args.py"), port=0)
    result = launch(target, root, base, timeout=20)
    assert result.status == "exited"
    assert "-- --remote-debugging-port=" in result.command
    assert "--remote-debugging-port=" in result.log_tail


def test_a_debugging_port_already_given_is_kept(project):
    root, base = project
    command = _python("args.py", "--remote-debugging-port={port}")
    result = launch(Target(kind="desktop", name="desk", command=command), root, base)
    assert result.command.count("--remote-debugging-port") == 1


def test_a_project_given_as_text_is_a_path(project):
    root, base = project
    result = launch(_api(_python("quiet_exit.py")), str(root), base, timeout=20)
    assert result.status == "exited"
    assert Path(result.log_path).parent == base / "logs"
