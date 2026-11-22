"""The environment a stdio MCP server of the WorkPilot loop starts with."""

import asyncio
from contextlib import AsyncExitStack, asynccontextmanager

import mcp.client.stdio as stdio_module
from core.mcp_tools import MCPToolManager


def _started_env(monkeypatch, cfg: dict) -> dict:
    seen: dict = {}

    @asynccontextmanager
    async def fake_stdio_client(params):
        seen["env"] = params.env
        raise RuntimeError("stop after the launch parameters")
        yield  # pragma: no cover - never reached

    monkeypatch.setattr(stdio_module, "stdio_client", fake_stdio_client)
    manager = MCPToolManager(project_dir=None, servers=[cfg], pin=False)

    async def open_once() -> None:
        manager._stack = AsyncExitStack()
        try:
            await manager._open_session(cfg)
        except RuntimeError:
            pass
        finally:
            await manager._stack.aclose()

    asyncio.run(open_once())
    return seen["env"]


def test_a_stdio_server_gets_the_default_list_and_its_own_env(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("WORKPILOT_TEST_UNRELATED_VALUE", "kept-out")
    cfg = {"id": "fs", "type": "command", "command": "npx", "env": {"ROOT": "/w"}}

    env = _started_env(monkeypatch, cfg)

    assert env["ROOT"] == "/w"
    assert env["PATH"] == "/usr/bin"
    assert "WORKPILOT_TEST_UNRELATED_VALUE" not in env


def test_a_stdio_server_without_env_still_gets_the_default_list(monkeypatch):
    monkeypatch.setenv("PATH", "/usr/bin")
    monkeypatch.setenv("WORKPILOT_TEST_UNRELATED_VALUE", "kept-out")
    cfg = {"id": "fs", "type": "command", "command": "npx"}

    env = _started_env(monkeypatch, cfg)

    assert env == stdio_module.get_default_environment()
    assert "WORKPILOT_TEST_UNRELATED_VALUE" not in env
