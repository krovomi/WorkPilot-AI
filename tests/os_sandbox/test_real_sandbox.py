"""The sandbox for real, on a machine that has one (bubblewrap, Seatbelt).

Each test runs a real command under the real sandbox and checks what it
could and could not do. On a machine without a sandbox they are skipped with
the probe's reason: what is tested there is that the card says so
(`test_session.py`).
"""

from __future__ import annotations

import asyncio
import http.server
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import os_sandbox
import pytest
from os_sandbox.launch import probe

pytestmark = pytest.mark.skipif(
    not probe().available and not os.environ.get("WORKPILOT_EXPECT_SANDBOX"),
    reason=f"no OS sandbox here: {probe().reason}",
)


def test_the_machine_has_the_sandbox_it_is_expected_to_have():
    # Under WORKPILOT_EXPECT_SANDBOX (the CI's Linux and macOS runners) a
    # missing sandbox is a failure with its reason, never a silent skip.
    assert probe().available, probe().reason


@pytest.fixture(autouse=True)
def _sandbox_on(monkeypatch):
    monkeypatch.setenv("WORKPILOT_SANDBOX", "auto")


@pytest.fixture
def tmp_path():
    """A directory outside /tmp.

    Inside the Linux sandbox /tmp is a private, empty tmpfs: a path under it
    is invisible and a write to it lands in that tmpfs, so a test whose files
    live there would pass for the wrong reason.
    """
    base = "/var/tmp" if Path("/var/tmp").is_dir() else str(Path.home())
    path = Path(tempfile.mkdtemp(prefix="wp-sandbox-test-", dir=base)).resolve()
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture
def home(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh" / "id_ed25519").write_text("not a key", encoding="utf-8")
    monkeypatch.setenv("HOME", str(home))
    return home


@pytest.fixture
def project(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    (project / ".workpilot-allowlist").write_text(
        f"ls\n{Path(sys.executable).name}\n", encoding="utf-8"
    )
    return project


class _Hello(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("Content-Length", "5")
        self.end_headers()
        self.wfile.write(b"hello")

    def log_message(self, *_args):
        pass


@pytest.fixture
def origin():
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Hello)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server.server_address[1]
    server.shutdown()


def _run(sandbox, script: str, cwd) -> subprocess.CompletedProcess:
    argv, env = sandbox.wrap(
        [sys.executable, "-I", "-c", script], {"PATH": "/usr/bin:/bin"}
    )
    return subprocess.run(
        argv, env=env, cwd=cwd, capture_output=True, text=True, timeout=60
    )


def test_writes_land_in_the_project_and_nowhere_else(tmp_path, project, home):
    sandbox = os_sandbox.session_sandbox(project)
    outside = tmp_path / "outside.txt"
    result = _run(
        sandbox,
        "import pathlib, sys\n"
        "pathlib.Path('inside.txt').write_text('ok')\n"
        "try:\n"
        f"    pathlib.Path({str(outside)!r}).write_text('x')\n"
        "    print('wrote outside')\n"
        "except OSError as e:\n"
        "    print('refused', e.errno)\n",
        project,
    )
    assert result.returncode == 0, result.stderr
    assert "refused" in result.stdout
    assert (project / "inside.txt").read_text(encoding="utf-8") == "ok"
    assert not outside.exists()


def test_the_projects_security_config_stays_read_only(project, home):
    sandbox = os_sandbox.session_sandbox(project)
    result = _run(
        sandbox,
        "import pathlib\n"
        "try:\n"
        "    pathlib.Path('.workpilot-allowlist').write_text('rm\\n')\n"
        "    print('changed')\n"
        "except OSError:\n"
        "    print('refused')\n",
        project,
    )
    assert "refused" in result.stdout
    assert (
        (project / ".workpilot-allowlist")
        .read_text(encoding="utf-8")
        .startswith("ls\n")
    )


def test_credentials_are_not_readable(project, home):
    sandbox = os_sandbox.session_sandbox(project)
    key = home / ".ssh" / "id_ed25519"
    result = _run(
        sandbox,
        "import pathlib\n"
        "try:\n"
        f"    print('read', pathlib.Path({str(key)!r}).read_text())\n"
        "except OSError:\n"
        "    print('hidden')\n",
        project,
    )
    assert "hidden" in result.stdout, result.stdout + result.stderr


def test_the_network_is_the_allowlist(project, home, origin, monkeypatch):
    monkeypatch.setenv("WORKPILOT_SANDBOX_HOSTS", f"127.0.0.1:{origin}")
    sandbox = os_sandbox.session_sandbox(project)
    script = (
        "import urllib.request\n"
        f"for url in ('http://127.0.0.1:{origin}/', 'http://example.com/'):\n"
        "    try:\n"
        "        print(url, urllib.request.urlopen(url, timeout=20).read().decode())\n"
        "    except Exception as e:\n"
        "        print(url, 'refused', getattr(e, 'code', type(e).__name__))\n"
    )
    result = _run(sandbox, script, project)
    assert f"http://127.0.0.1:{origin}/ hello" in result.stdout, (
        result.stdout + result.stderr
    )
    assert "http://example.com/ refused 403" in result.stdout
    assert "example.com:80" in sandbox.refused_hosts()


def test_run_command_runs_in_the_sandbox_and_names_a_refused_host(
    tmp_path, project, home
):
    from core.runtimes.tool_executor import ToolExecutor

    executor = ToolExecutor(str(project))
    outside = tmp_path / "outside.txt"
    with pytest.raises(RuntimeError):
        asyncio.run(executor._run_command(f"echo x > {outside}"))
    assert not outside.exists()
    out = asyncio.run(
        executor._run_command(
            f'{sys.executable} -I -c "import urllib.request\n'
            "try: urllib.request.urlopen('http://example.com/', timeout=20)\n"
            "except Exception as e: print('blocked')\""
        )
    )
    assert "blocked" in out
    assert "network refused: example.com:80" in out
