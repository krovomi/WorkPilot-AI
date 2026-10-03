"""How a build agent reaches ui-ux-pro-max, from the places every agent shares.

Same wiring as `brain.runtime`, one level narrower: the brain is offered to
every agent once a brain exists, ui-ux-pro-max only to an agent working on a
task whose preflight said **ui**. A backend task declares no server and no tool
— tool definitions are context a model reads on every turn.

| Where | What it adds |
|---|---|
| `agents.tools_pkg.models.get_required_mcp_servers` | ``"uiux"`` in the server list (``AGENT_MCP_<agent>_REMOVE=uiux`` removes it) |
| `core.client.create_client` | the ``workpilot-uiux`` server and its tools, allow-listed |
| `core.runtimes.tool_executor` | the same tools for Copilot, OpenAI/Codex, Gemini, Ollama… in-process |
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

__all__ = [
    "SERVER_KEY",
    "MCP_TOOL_NAMES",
    "active_for",
    "execute_tool",
    "is_uiux_tool",
    "mcp_server_config",
    "tool_definitions",
]

SERVER_KEY = "workpilot-uiux"

_BACKEND = Path(__file__).resolve().parent.parent


def _tool_names() -> tuple[str, ...]:
    from .mcp_server import TOOL_NAMES

    return TOOL_NAMES


MCP_TOOL_NAMES = tuple(f"mcp__{SERVER_KEY}__{name}" for name in _tool_names())


def active_for(spec_dir: Path | str | None) -> bool:
    """The preflight ran for this task, and said it is about the interface."""
    if not spec_dir:
        return False
    try:
        from .preflight import read_result
        from .runtime import skill_dir

        record = read_result(spec_dir)
        if not record or record.get("status") not in ("ready", "withheld"):
            return False
        if (record.get("relevance") or {}).get("verdict") != "ui":
            return False
        return skill_dir() is not None
    except Exception:  # noqa: BLE001 - an optional tool never breaks an agent
        return False


def mcp_server_config(project_dir: Path | str) -> dict[str, Any]:
    return {
        "command": sys.executable,
        "args": [
            str(_BACKEND / "runners" / "uiux_mcp.py"),
            "--project-dir",
            str(Path(project_dir).resolve()),
        ],
    }


def tool_definitions(spec_dir: Path | str | None) -> list[dict[str, Any]]:
    """`tool_executor`'s shape (``parameters``) of the MCP tool schemas."""
    if not active_for(spec_dir):
        return []
    from .mcp_server import TOOLS

    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["inputSchema"],
        }
        for tool in TOOLS
    ]


def is_uiux_tool(name: str) -> bool:
    return name in _tool_names()


def _call(project_dir: Path, name: str, arguments: dict[str, Any]) -> str:
    from . import engine
    from .mcp_server import call

    try:
        return call(Path(project_dir).resolve(), name, arguments)
    except (KeyError, ValueError, OSError, engine.EngineError) as exc:
        detail = f"missing argument {exc}" if isinstance(exc, KeyError) else str(exc)
        return f"Error: {detail}"


async def execute_tool(
    name: str, arguments: dict[str, Any], project_dir: Path | str
) -> str:
    """Run a tool off the event loop: the engine is a subprocess."""
    return await asyncio.to_thread(
        _call, Path(project_dir), name, dict(arguments or {})
    )
