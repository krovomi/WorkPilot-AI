"""The recorder runner, started the way the desktop app starts it.

Exporting runs the real command on a recording sent on stdin. Recording needs
a Chromium with a window, which the CI does not have: the command's refusal
and its failure without a browser are checked for real, a session with a
stand-in browser in-process.
"""

from __future__ import annotations

import asyncio
import importlib.util
import io
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "browser_recorder_runner.py"

RECORDING = {
    "steps": [
        {"id": "s1", "kind": "navigate", "url": "http://localhost:3000/"},
        {
            "id": "s2",
            "kind": "click",
            "selectors": [{"strategy": "role", "role": "button", "value": "Go"}],
        },
    ]
}


def _run(*args: str, stdin: str = "", env: dict | None = None):
    done = subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, **(env or {})},
        timeout=120,
        check=False,
    )
    return done.returncode, done.stdout.splitlines()


def _line(lines: list[str], prefix: str):
    [found] = [line for line in lines if line.startswith(prefix)]
    return json.loads(found[len(prefix) :])


def test_export_prints_the_test(tmp_path: Path) -> None:
    (tmp_path / "e2e").mkdir()
    code, lines = _run(
        "export",
        "--format",
        "playwright-ts",
        "--name",
        "Go home",
        "--root",
        str(tmp_path),
        stdin=json.dumps(RECORDING),
    )
    assert code == 0
    test = _line(lines, "RECORDER_EXPORT:")
    assert test["path"] == "e2e/go-home.spec.ts" and test["format"] == "playwright-ts"
    assert 'await page.goto("http://localhost:3000/");' in test["code"]


def test_export_refuses_what_is_not_a_recording() -> None:
    code, lines = _run("export", "--format", "cypress", stdin='{"steps": []}')
    assert code == 1
    assert _line(lines, "RECORDER_ERROR:") == "The recording has no step to export."
    code, lines = _run("export", "--format", "cypress", stdin="not json")
    assert code == 1 and _line(lines, "RECORDER_ERROR:")
    code, _ = _run("export", "--format", "selenium", stdin="{}")
    assert code == 2


def test_record_refuses_a_bad_address_and_a_missing_project(tmp_path: Path) -> None:
    code, lines = _run(
        "record", "--url", "file:///etc/passwd", "--project", str(tmp_path)
    )
    assert code == 1
    assert _line(lines, "RECORDER_ERROR:").startswith("Only an http:// or https://")
    code, lines = _run(
        "record", "--url", "http://x.test", "--project", str(tmp_path / "no")
    )
    assert code == 1
    assert _line(lines, "RECORDER_ERROR:").startswith("Project directory not found")


def test_a_strict_offline_project_only_records_a_local_page(tmp_path: Path) -> None:
    policy = tmp_path / ".workpilot" / "offline-mode.json"
    policy.parent.mkdir()
    policy.write_text('{"airgapStrict": true}', encoding="utf-8")
    code, lines = _run(
        "record", "--url", "https://example.com", "--project", str(tmp_path)
    )
    assert code == 1
    assert "strict offline mode" in _line(lines, "RECORDER_ERROR:")


def test_without_a_browser_recording_fails_cleanly(tmp_path: Path) -> None:
    code, lines = _run(
        "record",
        "--url",
        "http://127.0.0.1:9/",
        "--project",
        str(tmp_path),
        env={"PLAYWRIGHT_BROWSERS_PATH": str(tmp_path / "no-browsers")},
    )
    assert code == 1 and _line(lines, "RECORDER_ERROR:")


# --- in-process --------------------------------------------------------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("recorder_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_only_loopback_hosts_are_local(runner) -> None:
    for url in (
        "http://localhost:3000",
        "http://app.localhost/",
        "http://127.0.0.2",
        "http://[::1]:8080",
    ):
        assert runner.is_local_url(url), url
    for url in ("https://example.com", "http://10.0.0.1", "http://localhost.evil.com"):
        assert not runner.is_local_url(url), url


async def test_stdin_stops_on_a_stop_line_or_its_end(runner, monkeypatch) -> None:
    monkeypatch.setattr(sys, "stdin", io.StringIO("noise\nstop\nlater\n"))
    control = runner.Control()
    await control.listen()
    assert control.stopped.is_set() and sys.stdin.readline() == "later\n"
    monkeypatch.setattr(sys, "stdin", io.StringIO(""))
    ended = runner.Control()
    await ended.listen()
    assert ended.stopped.is_set()


async def test_a_dialog_is_asked_of_the_app_and_answered_on_stdin(
    runner, capsys
) -> None:
    gate = asyncio.Event()
    lines = [
        # An answer to a dialog already gone, then lines that are not answers.
        'dialog {"id": 7, "accept": true}\n',
        "dialog not json\n",
        'dialog {"id": 1, "accept": "yes"}\n',
        'dialog {"id": "1", "accept": true}\n',
        'dialog {"id": 1, "accept": true, "text": "Neo"}\n',
        'dialog {"id": 2, "accept": false, "text": 4}\n',
        "stop\n",
    ]

    async def read() -> str:
        await gate.wait()
        return lines.pop(0)

    control = runner.Control(read)
    listening = asyncio.ensure_future(control.listen())
    asking = asyncio.ensure_future(
        control.ask_dialog({"type": "prompt", "message": "Name?"})
    )
    await asyncio.sleep(0)
    gate.set()
    assert await asking == (True, "Neo")
    assert await control.ask_dialog({"type": "alert", "message": "!"}) == (False, "")
    await listening
    out = capsys.readouterr().out.splitlines()
    assert _line(out[:1], "RECORDER_DIALOG:") == {
        "id": 1,
        "type": "prompt",
        "message": "Name?",
    }
    assert runner.read_answer("x" * (runner.MAX_ANSWER + 1)) is None


async def test_a_dialog_nobody_answers_is_dismissed(runner, monkeypatch) -> None:
    monkeypatch.setattr(runner, "DIALOG_TIMEOUT_S", 0.01)
    control = runner.Control()
    assert await control.ask_dialog({"type": "alert", "message": ""}) is None


class Frame:
    url = ""


class Page:
    def __init__(self) -> None:
        self.main_frame = Frame()
        self.binding = None

    async def expose_binding(self, _name, callback) -> None:
        self.binding = callback

    async def add_init_script(self, script: str) -> None:
        assert script

    def on(self, _event, _handler) -> None:
        return None

    async def goto(self, url: str, wait_until: str, timeout: int) -> None:
        await self.binding(
            {"frame": self.main_frame},
            {"kind": "click", "target": {"tag": "a", "role": "link", "name": "Docs"}},
        )


class Controller:
    def __init__(self) -> None:
        self.page = Page()
        self.events: list[str] = []

    async def launch(self) -> None:
        self.events.append("launch")

    async def close(self) -> None:
        self.events.append("close")


def test_a_session_streams_its_steps_then_its_summary(
    runner, monkeypatch, tmp_path: Path, capsys
) -> None:
    controller = Controller()
    monkeypatch.setattr(runner, "_controller", lambda _project: controller)

    async def stop_line() -> str:
        return "stop\n"

    real = runner.Control
    monkeypatch.setattr(runner, "Control", lambda: real(stop_line))
    code = runner.main(
        ["record", "--url", "http://localhost:3000", "--project", str(tmp_path)]
    )
    lines = capsys.readouterr().out.splitlines()
    assert code == 0 and controller.events == ["launch", "close"]
    assert [json.loads(line[14:])["kind"] for line in lines[:2]] == [
        "navigate",
        "click",
    ]
    assert _line(lines, "RECORDER_DONE:") == {
        "reason": "stopped",
        "steps": 2,
        "truncated": False,
    }


def test_the_real_controller_opens_a_window(runner, tmp_path: Path) -> None:
    controller = runner._controller(tmp_path)
    assert controller.headless is False
    with pytest.raises(RuntimeError, match="Browser not launched"):
        _ = controller.page
    controller._page = object()
    assert controller.page is controller._page


def test_an_oversized_recording_is_refused(runner) -> None:
    with pytest.raises(ValueError, match="too large"):
        runner.run_export("x" * (runner.MAX_INPUT + 1), "cypress", None, None)
