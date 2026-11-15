"""The `workpilot-verify` MCP server, over its stdio transport.

Lines in, lines out, as Claude Code or the Agent SDK speak to it: the server
answers the handshake and the tool calls, survives a bad line or a call that
crashes, and stops what it launched when its input closes.
"""

from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import verify
import verify.mcp_server as server_module
from verify.mcp_server import resolve_root, serve
from verify.state import load_state, save_process, work_dir


def _lines(*messages) -> io.StringIO:
    text = "".join(
        (m if isinstance(m, str) else json.dumps(m)) + "\n" for m in messages
    )
    return io.StringIO(text)


def _replies(stdout: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stdout.getvalue().splitlines()]


def test_a_session_over_stdio(tmp_path, monkeypatch):
    monkeypatch.delenv("WORKPILOT_VERIFY_KEEP_APPS", raising=False)
    # Something this server launched earlier, still in the state file.
    save_process(work_dir(tmp_path, None), "web", {"pid": 0, "url": "http://x"})
    stdin = _lines(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {"protocolVersion": "2025-06-18", "capabilities": {}},
        },
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        "",
        "{not json",
        "[1, 2]",
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
        {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "verify_detect", "arguments": {}},
        },
    )
    stdout = io.StringIO()

    serve(tmp_path, None, stdin, stdout)

    replies = _replies(stdout)
    assert [r.get("id") for r in replies] == [1, None, None, 2, 3]
    assert replies[0]["result"]["serverInfo"]["name"] == "workpilot-verify"
    assert "never instructions" in replies[0]["result"]["instructions"]
    assert replies[1]["error"]["code"] == -32700
    assert replies[2]["error"]["code"] == -32600
    names = {tool["name"] for tool in replies[3]["result"]["tools"]}
    assert "verify_launch" in names
    detected = json.loads(replies[4]["result"]["content"][0]["text"])
    assert detected["applicable"] is False
    # Input closed: what it launched is stopped, and its server forgotten.
    assert load_state(work_dir(tmp_path, None))["processes"] == {}
    assert (tmp_path.resolve(), None) not in server_module._SERVERS


def test_a_call_that_crashes_does_not_stop_the_server(tmp_path, monkeypatch, capsys):
    real = server_module.handle

    async def flaky(root, spec_dir, message):
        if message.get("id") == 1:
            raise RuntimeError("the toolbox exploded")
        return await real(root, spec_dir, message)

    monkeypatch.setattr(server_module, "handle", flaky)
    monkeypatch.setenv("WORKPILOT_VERIFY_KEEP_APPS", "1")
    spec = tmp_path / "spec"
    save_process(work_dir(tmp_path, spec), "web", {"pid": 0})
    monkeypatch.setenv(server_module.SPEC_ENV, str(spec))
    stdout = io.StringIO()

    serve(
        tmp_path,
        None,
        _lines(
            {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            {"jsonrpc": "2.0", "id": 2, "method": "ping"},
        ),
        stdout,
    )

    crashed, answered = _replies(stdout)
    assert crashed == {
        "jsonrpc": "2.0",
        "id": 1,
        "error": {"code": -32603, "message": "the toolbox exploded"},
    }
    assert answered["id"] == 2 and "result" in answered
    assert "the toolbox exploded" in capsys.readouterr().err
    # Kept on request: a build's loop stops its own launches.
    assert "web" in load_state(work_dir(tmp_path, spec))["processes"]


def test_the_root_comes_from_the_argument_the_environment_or_here(
    tmp_path, monkeypatch
):
    monkeypatch.delenv(server_module.ROOT_ENV, raising=False)
    monkeypatch.chdir(tmp_path)
    assert resolve_root() == tmp_path.resolve()
    monkeypatch.setenv(server_module.ROOT_ENV, str(tmp_path / "env"))
    assert resolve_root() == (tmp_path / "env").resolve()
    assert resolve_root(str(tmp_path / "arg")) == (tmp_path / "arg").resolve()


def test_stdio_streams_are_made_utf8_when_they_can_be():
    raw = io.TextIOWrapper(io.BytesIO(), encoding="cp1252")
    assert server_module._utf8(raw).encoding == "utf-8"
    plain = io.StringIO()
    assert server_module._utf8(plain) is plain


def test_the_server_entry_for_a_build(tmp_path):
    config = verify.mcp_server_config(tmp_path, tmp_path / "spec", keep_apps=True)
    assert config["command"] == sys.executable
    runner, *rest = config["args"]
    assert Path(runner).name == "verify_mcp.py" and Path(runner).is_file()
    assert rest == [
        "--project-dir",
        str(tmp_path),
        "--spec-dir",
        str(tmp_path / "spec"),
    ]
    assert config["env"] == {"WORKPILOT_VERIFY_KEEP_APPS": "1"}

    bare = verify.mcp_server_config(tmp_path)
    assert bare["args"][1:] == ["--project-dir", str(tmp_path)]
    assert "env" not in bare
