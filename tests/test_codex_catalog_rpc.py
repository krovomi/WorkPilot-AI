"""Exercise the discovery transport with an actual local JSONL subprocess."""

import sys
from pathlib import Path
from unittest.mock import Mock

import pytest
from core import codex_catalog_rpc as rpc


def fake_server(monkeypatch, tmp_path: Path, source: str):
    script = tmp_path / "server.py"
    script.write_text(source, encoding="utf-8")
    monkeypatch.setattr(rpc, "find_executable", lambda _: sys.executable)
    monkeypatch.setattr(rpc, "_command", lambda _: [sys.executable, "-u", str(script)])


def test_handshake_pagination_and_visible_future_models(monkeypatch, tmp_path):
    fake_server(
        monkeypatch,
        tmp_path,
        """
import json, sys
def read(): return json.loads(sys.stdin.readline())
def send(value): print(json.dumps(value), flush=True)
init = read()
assert init["method"] == "initialize"
send({"id": init["id"], "result": {}})
assert read()["method"] == "initialized"
first = read()
assert first["method"] == "model/list"
assert first["params"]["includeHidden"] is False
send({"method": "notification"})
send({"id": first["id"], "result": {"data": [
    {"model": "hidden", "hidden": True},
    {"model": "gpt-6-sol", "displayName": "GPT-6 Sol", "supportedReasoningEfforts": [{"reasoningEffort": "high"}]}
], "nextCursor": "page2"}})
second = read()
assert second["params"]["cursor"] == "page2"
send({"id": second["id"], "result": {"data": [{"model": "future-model"}], "nextCursor": None}})
assert sys.stdin.read() == ""
""",
    )
    models = rpc.discover_models()
    assert [m["value"] for m in models] == ["gpt-6-sol", "future-model"]
    assert models[0]["supportsThinking"]
    assert models[1]["label"] == "future-model"


@pytest.mark.parametrize(
    "response", ['{"id":1,"error":{"message":"private"}}', "not-json", "[]"]
)
def test_invalid_response_stops_process(monkeypatch, tmp_path, response):
    fake_server(
        monkeypatch,
        tmp_path,
        f"import sys\nsys.stdin.readline()\nprint({response!r}, flush=True)\nsys.stdin.read()\n",
    )
    with pytest.raises(ValueError):
        rpc.discover_models()


def test_timeout_is_bounded(monkeypatch, tmp_path):
    fake_server(monkeypatch, tmp_path, "import sys\nsys.stdin.read()\n")
    monkeypatch.setattr(rpc, "TIMEOUT_SECONDS", 0.1)
    with pytest.raises(TimeoutError):
        rpc.discover_models()


def test_unresponsive_process_is_reaped(monkeypatch, tmp_path):
    fake_server(monkeypatch, tmp_path, "import time\ntime.sleep(60)\n")
    monkeypatch.setattr(rpc, "TIMEOUT_SECONDS", 0.2)
    original_spawn = rpc.subprocess.Popen
    processes = []

    def spawn(*args, **kwargs):
        process = original_spawn(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(rpc.subprocess, "Popen", spawn)
    with pytest.raises(TimeoutError):
        rpc.discover_models()
    assert processes[0].poll() is not None


def test_missing_cli_does_not_spawn(monkeypatch):
    monkeypatch.setattr(rpc, "find_executable", lambda _: None)
    spawn = Mock()
    monkeypatch.setattr(rpc.subprocess, "Popen", spawn)
    with pytest.raises(OSError):
        rpc.discover_models()
    spawn.assert_not_called()


def test_windows_wrapper_quotes_are_not_backslash_escaped(monkeypatch):
    monkeypatch.setattr(rpc, "is_windows", lambda: True)
    monkeypatch.setattr(
        rpc,
        "build_windows_command",
        lambda *_: [
            "cmd.exe",
            "/d",
            "/s",
            "/c",
            '"C:\\Program Files\\codex.cmd" app-server',
        ],
    )
    assert (
        rpc._command("C:\\Program Files\\codex.cmd")
        == 'cmd.exe /d /s /c ""C:\\Program Files\\codex.cmd" app-server"'
    )
