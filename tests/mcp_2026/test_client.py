"""WorkPilot's MCP client (`core/mcp_tools.py`) against real 2026-07-28 servers.

The servers are real processes over stdio: a `mcp_tasks.ToolServer` like
WorkPilot's own, an MCP Apps server written with the Python SDK, and the
``workpilot-verify`` server itself. `resolve_task` is then checked alone
against a scripted session for the outcomes those servers never produce.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import core.mcp_tools as mcp_tools
import pytest
from core.mcp_extensions import (
    TASK_TIMEOUT_ENV,
    VIEW_ID,
    _models,
    app_resource_uri,
    resolve_task,
    task_timeout,
    visible_to_model,
)
from core.mcp_tools import MCPToolManager
from core.task_event import TASK_EVENT_PREFIX

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "mcp_2026"
VERIFY_RUNNER = ROOT / "apps" / "backend" / "runners" / "verify_mcp.py"


def _command(sid: str, script: Path, *args: str, env: dict | None = None) -> dict:
    entry = {
        "id": sid,
        "type": "command",
        "command": sys.executable,
        "args": [str(script), *args],
    }
    if env:
        entry["env"] = env
    return entry


def _events(output: str) -> list[dict]:
    return [
        json.loads(line[len(TASK_EVENT_PREFIX) :])
        for line in output.splitlines()
        if line.startswith(TASK_EVENT_PREFIX)
    ]


def _spy_resolve(monkeypatch) -> list[str]:
    seen: list[str] = []

    async def spy(session, created, **kwargs):
        seen.append(created.task_id)
        return await resolve_task(session, created, **kwargs)

    monkeypatch.setattr(mcp_tools, "resolve_task", spy)
    return seen


class TestTasksEndToEnd:
    def test_a_long_tool_comes_back_as_a_task_and_is_awaited(self, monkeypatch):
        seen = _spy_resolve(monkeypatch)

        async def run():
            async with MCPToolManager(
                None, [_command("tasks", FIXTURES / "task_server.py")]
            ) as mcp:
                session, _ = mcp._route["mcp__tasks__slow"]
                return (
                    session.protocol_version,
                    await mcp.call("mcp__tasks__slow", {}),
                    await mcp.call("mcp__tasks__quick", {}),
                )

        version, slow, quick = asyncio.run(run())
        assert version == "2026-07-28"
        assert slow == "slow done"
        assert quick == "quick done"
        # Only the long tool was a task: one handle, polled to its end.
        assert len(seen) == 1 and len(seen[0]) >= 32

    def test_a_stopped_build_cancels_the_servers_task(self, tmp_path):
        marker = tmp_path / "cancelled"

        async def run():
            servers = [
                _command(
                    "tasks",
                    FIXTURES / "task_server.py",
                    env={"TASK_SERVER_CANCELLED_MARKER": str(marker)},
                )
            ]
            async with MCPToolManager(None, servers) as mcp:
                call = asyncio.ensure_future(mcp.call("mcp__tasks__hang", {}))
                await asyncio.sleep(1.0)
                call.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await asyncio.gather(call)
                # The cancel reached the server: its work was stopped.
                for _ in range(50):
                    if marker.exists():
                        break
                    await asyncio.sleep(0.1)

        asyncio.run(run())
        assert marker.read_text(encoding="utf-8") == "cancelled"


class TestAppsEndToEnd:
    def test_an_app_only_tool_never_reaches_the_agent(self):
        async def run():
            async with MCPToolManager(
                None, [_command("weather", FIXTURES / "apps_server.py")]
            ) as mcp:
                return {d["name"] for d in mcp.tool_definitions()}

        names = asyncio.run(run())
        assert "mcp__weather__weather" in names
        assert "mcp__weather__refresh" not in names

    def test_a_tool_with_a_view_is_kept_for_the_task_panel(self, tmp_path, capfd):
        spec = tmp_path / "spec"
        spec.mkdir()

        async def run():
            servers = [_command("weather", FIXTURES / "apps_server.py")]
            async with MCPToolManager(None, servers, spec_dir=spec) as mcp:
                return await mcp.call("mcp__weather__weather", {"city": "Paris"})

        text = asyncio.run(run())
        # The agent reads the result as before.
        assert text == "sunny in Paris"
        views = list((spec / "mcp-apps").glob("*.json"))
        assert len(views) == 1
        view = json.loads(views[0].read_text(encoding="utf-8"))
        assert VIEW_ID.match(view["viewId"]) and views[0].stem == view["viewId"]
        assert view["server"] == "weather" and view["tool"] == "weather"
        assert view["resourceUri"] == "ui://weather/view.html"
        assert view["html"].startswith("<!doctype html>")
        assert view["ui"]["csp"]["connectDomains"] == ["https://api.weather.example"]
        assert view["toolInput"] == {"city": "Paris"}
        assert view["toolResult"]["content"][0]["text"] == "sunny in Paris"
        events = [
            e for e in _events(capfd.readouterr().out) if e["type"] == "MCP_APP_VIEW"
        ]
        assert [e["mcpApp"] for e in events] == [
            {"viewId": view["viewId"], "server": "weather", "tool": "weather"}
        ]

    def test_without_a_task_panel_nothing_is_kept(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)

        async def run():
            async with MCPToolManager(
                None, [_command("weather", FIXTURES / "apps_server.py")]
            ) as mcp:
                assert mcp._views == {}
                return await mcp.call("mcp__weather__weather", {"city": "Lyon"})

        assert asyncio.run(run()) == "sunny in Lyon"
        assert not list(tmp_path.rglob("mcp-apps"))


class TestVerifyServer:
    def test_verify_launch_is_a_task_for_a_modern_client(self, tmp_path, monkeypatch):
        seen = _spy_resolve(monkeypatch)
        project = tmp_path / "project"
        project.mkdir()

        async def run():
            servers = [_command("verify", VERIFY_RUNNER, "--project-dir", str(project))]
            async with MCPToolManager(None, servers) as mcp:
                session, _ = mcp._route["mcp__verify__verify_launch"]
                return session.protocol_version, await mcp.call(
                    "mcp__verify__verify_launch", {}
                )

        version, text = asyncio.run(run())
        assert version == "2026-07-28"
        assert len(seen) == 1
        # An empty project has nothing to launch: the tool's own answer, unchanged.
        assert text.startswith("MCP tool error: Error:")


# ── resolve_task alone ──────────────────────────────────────────────────


class _Session:
    """Answers ``tasks/get`` from a script, and records the cancels."""

    def __init__(self, *details: dict):
        self._details = list(details)
        self.cancelled: list[str] = []

    async def send_request(self, request, result_type):
        if request.method == "tasks/cancel":
            self.cancelled.append(request.params.task_id)
            return result_type.model_validate({"resultType": "complete"})
        detail = self._details.pop(0) if len(self._details) > 1 else self._details[0]
        return result_type.model_validate(detail)


def _created(status="working"):
    return _models()["CreateTaskResult"].model_validate(
        {"resultType": "task", "taskId": "t1", "status": status, "pollIntervalMs": 1}
    )


async def _no_sleep(_seconds):
    return None


def _resolve(session, **kwargs):
    return asyncio.run(resolve_task(session, _created(), sleep=_no_sleep, **kwargs))


def _text(result) -> str:
    return result.content[0].text


class TestResolveTask:
    def test_completed_returns_the_tool_result(self):
        session = _Session(
            {"taskId": "t1", "status": "working"},
            {
                "taskId": "t1",
                "status": "completed",
                "result": {"content": [{"type": "text", "text": "ok"}]},
            },
        )
        result = _resolve(session)
        assert _text(result) == "ok" and not result.is_error
        assert session.cancelled == []

    def test_a_task_asking_for_input_is_cancelled(self):
        session = _Session(
            {"taskId": "t1", "status": "input_required", "inputRequests": {"q": {}}}
        )
        result = _resolve(session)
        assert result.is_error and "asks for input" in _text(result)
        assert session.cancelled == ["t1"]

    def test_a_task_past_its_deadline_is_cancelled(self, monkeypatch):
        now = [0.0]

        async def tick(_seconds):
            now[0] += 5

        monkeypatch.setenv(TASK_TIMEOUT_ENV, "12")
        session = _Session({"taskId": "t1", "status": "working"})
        result = asyncio.run(
            resolve_task(session, _created(), sleep=tick, clock=lambda: now[0])
        )
        assert result.is_error and "within 12s" in _text(result)
        assert session.cancelled == ["t1"]

    def test_a_failed_task_says_why(self):
        session = _Session(
            {
                "taskId": "t1",
                "status": "failed",
                "error": {"code": -32603, "message": "no app"},
            }
        )
        result = _resolve(session)
        assert result.is_error and _text(result) == "The MCP task failed: no app"

    def test_a_result_that_is_not_a_tool_result_is_an_error(self):
        session = _Session(
            {"taskId": "t1", "status": "completed", "result": {"content": "nope"}}
        )
        result = _resolve(session)
        assert result.is_error and "not a tool result" in _text(result)

    def test_an_answer_for_another_task_is_refused(self):
        session = _Session(
            {"taskId": "other", "status": "completed", "result": {"content": []}}
        )
        assert "another task" in _text(_resolve(session))

    def test_a_server_side_cancel_is_an_error(self):
        session = _Session({"taskId": "t1", "status": "cancelled"})
        assert _text(_resolve(session)) == "The MCP server cancelled the task."

    @pytest.mark.parametrize(
        ("raw", "expected"),
        [("", 1800.0), ("abc", 1800.0), ("-3", 1800.0), ("90", 90.0)],
    )
    def test_the_timeout_setting(self, monkeypatch, raw, expected):
        monkeypatch.setenv(TASK_TIMEOUT_ENV, raw)
        assert task_timeout() == expected


class TestToolUi:
    def test_visibility_and_resource(self):
        assert visible_to_model(None)
        assert visible_to_model({"ui": {"visibility": ["model", "app"]}})
        assert not visible_to_model({"ui": {"visibility": ["app"]}})
        assert app_resource_uri({"ui": {"resourceUri": "ui://a/b"}}) == "ui://a/b"
        # The deprecated flat key is still read; a non-ui:// uri is not a view.
        assert app_resource_uri({"ui/resourceUri": "ui://a/c"}) == "ui://a/c"
        assert (
            app_resource_uri({"ui": {"resourceUri": "https://evil.example/x"}}) is None
        )


def test_an_older_sdk_keeps_the_handshake(monkeypatch):
    monkeypatch.setattr(mcp_tools, "sdk_speaks_2026", lambda: False)
    session = SimpleNamespace(initialized=False)

    async def initialize():
        session.initialized = True

    session.initialize = initialize
    asyncio.run(mcp_tools._handshake(session))
    assert session.initialized
