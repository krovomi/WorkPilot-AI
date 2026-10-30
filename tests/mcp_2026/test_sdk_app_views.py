"""MCP App views on the Claude Agent SDK path (plan of 29 October, IA4).

There Claude Code is the MCP client: it calls the tool and shows no view.
`make_app_view_hook` runs after the call, opens its own short session to the
same server, and keeps the view with the call's input and result, as the
WorkPilot loop does. The servers are real processes over stdio.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import core.mcp_tools as mcp_tools
from core.mcp_extensions import VIEW_ID
from core.mcp_tools import make_app_view_hook
from core.task_event import TASK_EVENT_PREFIX

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "mcp_2026"


def _command(sid: str, script: Path, **extra) -> dict:
    return {
        "id": sid,
        "name": sid,
        "type": "command",
        "command": sys.executable,
        "args": [str(script)],
        **extra,
    }


def _post(hook, name: str, arguments: dict, response) -> dict:
    return asyncio.run(
        hook(
            {
                "hook_event_name": "PostToolUse",
                "tool_name": name,
                "tool_input": arguments,
                "tool_response": response,
            }
        )
    )


def _views(spec: Path) -> list[dict]:
    return [
        json.loads(path.read_text(encoding="utf-8"))
        for path in sorted((spec / "mcp-apps").glob("*.json"))
    ]


def _count_sessions(monkeypatch) -> list[list[dict]]:
    """Every side session the hook opens, with the servers it was given."""
    opened: list[list[dict]] = []
    real = mcp_tools.MCPToolManager

    class Counting(real):
        def __init__(self, project_dir, servers=None, **kwargs):
            opened.append(list(servers or []))
            super().__init__(project_dir, servers, **kwargs)

    monkeypatch.setattr(mcp_tools, "MCPToolManager", Counting)
    return opened


class TestTheViewIsKept:
    def test_a_call_made_by_claude_code_keeps_its_view(self, tmp_path, capfd):
        spec = tmp_path / "spec"
        spec.mkdir()
        hook = make_app_view_hook(
            spec, [_command("weather", FIXTURES / "apps_server.py")]
        )
        response = [{"type": "text", "text": "sunny in Paris"}]

        # The hook never changes what the agent reads.
        assert _post(hook, "mcp__weather__weather", {"city": "Paris"}, response) == {}

        [view] = _views(spec)
        assert VIEW_ID.match(view["viewId"])
        assert view["server"] == "weather" and view["tool"] == "weather"
        assert view["resourceUri"] == "ui://weather/view.html"
        assert view["html"].startswith("<!doctype html>")
        assert view["toolInput"] == {"city": "Paris"}
        assert view["toolResult"]["content"] == response
        events = [
            json.loads(line[len(TASK_EVENT_PREFIX) :])
            for line in capfd.readouterr().out.splitlines()
            if line.startswith(TASK_EVENT_PREFIX)
        ]
        assert [e["mcpApp"] for e in events if e["type"] == "MCP_APP_VIEW"] == [
            {"viewId": view["viewId"], "server": "weather", "tool": "weather"}
        ]

    def test_every_shape_of_tool_response_becomes_a_tool_result(self, tmp_path):
        spec = tmp_path / "spec"
        spec.mkdir()
        hook = make_app_view_hook(
            spec, [_command("weather", FIXTURES / "apps_server.py")]
        )
        _post(hook, "mcp__weather__weather", {"city": "Lyon"}, "sunny in Lyon")
        _post(
            hook,
            "mcp__weather__weather",
            {"city": "Nice"},
            {"content": [{"type": "text", "text": "sunny in Nice"}], "isError": False},
        )

        results = sorted(v["toolResult"]["content"][0]["text"] for v in _views(spec))
        assert results == ["sunny in Lyon", "sunny in Nice"]

    def test_the_side_session_starts_the_server_as_claude_code_does(
        self, tmp_path, monkeypatch
    ):
        # `core.client._custom_servers` starts a command server with its
        # command and arguments only; so does the side session.
        opened = _count_sessions(monkeypatch)
        spec = tmp_path / "spec"
        spec.mkdir()
        server = _command(
            "weather", FIXTURES / "apps_server.py", env={"EXTRA": "x"}, extra=1
        )
        hook = make_app_view_hook(spec, [server])
        _post(hook, "mcp__weather__weather", {"city": "Paris"}, "sunny")

        assert opened and "env" not in opened[0][0] and "extra" not in opened[0][0]
        assert len(_views(spec)) == 1


class TestNothingElseIsStarted:
    def test_a_tool_of_another_server_starts_nothing(self, tmp_path, monkeypatch):
        opened = _count_sessions(monkeypatch)
        hook = make_app_view_hook(
            tmp_path, [_command("weather", FIXTURES / "apps_server.py")]
        )

        assert _post(hook, "mcp__context7__resolve", {}, "x") == {}
        assert _post(hook, "Bash", {"command": "ls"}, "x") == {}
        assert opened == []

    def test_a_server_without_views_is_listed_once(self, tmp_path, monkeypatch):
        opened = _count_sessions(monkeypatch)
        spec = tmp_path / "spec"
        spec.mkdir()
        hook = make_app_view_hook(
            spec, [_command("tasks", FIXTURES / "task_server.py")]
        )

        _post(hook, "mcp__tasks__quick", {}, "quick done")
        _post(hook, "mcp__tasks__quick", {}, "quick done")
        _post(hook, "mcp__tasks__slow", {}, "slow done")

        assert len(opened) == 1
        assert not (spec / "mcp-apps").exists()

    def test_a_server_that_fails_is_skipped_and_tried_again(
        self, tmp_path, monkeypatch
    ):
        opened = _count_sessions(monkeypatch)
        missing = _command("broken", tmp_path / "no_such_server.py")
        hook = make_app_view_hook(tmp_path, [missing])

        assert _post(hook, "mcp__broken__anything", {}, "x") == {}
        assert _post(hook, "mcp__broken__anything", {}, "x") == {}
        # Not remembered as "no views": a server down once may answer later.
        assert len(opened) == 2

    def test_a_slow_server_does_not_hold_the_agent(self, tmp_path, monkeypatch):
        monkeypatch.setattr(mcp_tools, "APP_VIEW_CAPTURE_TIMEOUT", 0.05)

        async def stuck(*_args, **_kwargs):
            await asyncio.sleep(10)

        monkeypatch.setattr(mcp_tools.MCPToolManager, "connect", stuck)
        hook = make_app_view_hook(
            tmp_path, [_command("weather", FIXTURES / "apps_server.py")]
        )

        assert _post(hook, "mcp__weather__weather", {}, "x") == {}
        assert not (tmp_path / "mcp-apps").exists()


class TestClaudeClientWiring:
    def test_only_the_custom_servers_the_session_starts(self):
        from core.client import _app_view_servers

        custom = [
            {"id": "weather", "name": "w", "type": "command", "command": "npx"},
            {"id": "other", "name": "o", "type": "command", "command": "npx"},
        ]
        started = {"weather": {}, "context7": {}}

        assert _app_view_servers(started, {"CUSTOM_MCP_SERVERS": custom}) == [custom[0]]
        assert _app_view_servers(started, {}) == []

    def test_the_hook_is_registered_only_with_a_custom_server(self, tmp_path):
        from core.client import _session_hooks

        def matchers(hooks: dict) -> list:
            return [m.matcher for m in hooks["PostToolUse"]]

        bare = _session_hooks(tmp_path, tmp_path, [])
        assert "mcp__.*" not in matchers(bare)

        server = _command("weather", FIXTURES / "apps_server.py")
        wired = _session_hooks(tmp_path, tmp_path, [], app_view_servers=[server])
        assert matchers(wired).count("mcp__.*") == 1
        # The sub-agent hook is still there.
        assert set(matchers(bare)) <= set(matchers(wired))
