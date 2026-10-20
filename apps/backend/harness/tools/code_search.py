"""How every agent reaches `search_code`, from the places they already share.

Same wiring as `brain.runtime` and `uiux.integration`, with one difference: the
tool is a right an agent type declares (``"code"`` in its
``AGENT_CONFIGS[...]["mcp_servers"]``), not something offered to every agent.

| Where | What it adds |
|---|---|
| `agents.tools_pkg.permissions.mcp_tools_for_servers` | `MCP_TOOL_NAMES` for a type that declares ``code`` |
| `core.client.create_client` | the ``workpilot-code`` server for the session's project, its tool allow-listed |
| `core.runtimes.tool_executor` | the same tool in-process, offered and run only for a type that declares it |
| `runners/code_search_mcp.py` | the same server, for an agent a person attaches it to |
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

__all__ = [
    "DECLARATION",
    "MCP_TOOL_NAMES",
    "SERVER_KEY",
    "TOOL_NAME",
    "TOOLS",
    "call",
    "execute_tool",
    "is_code_search_tool",
    "mcp_server_config",
    "tool_definitions",
]

SERVER_KEY = "workpilot-code"
TOOL_NAME = "search_code"
#: The ``mcp_servers`` entry of `AGENT_CONFIGS` that grants the tool.
DECLARATION = "code"
MCP_TOOL_NAMES = (f"mcp__{SERVER_KEY}__{TOOL_NAME}",)

_BACKEND = Path(__file__).resolve().parent.parent.parent

TOOLS: list[dict[str, Any]] = [
    {
        "name": TOOL_NAME,
        "description": (
            "Ranked code excerpts from this project for a question or for "
            "identifiers: the functions, classes and methods that best match, "
            "best first (BM25 over code split by symbol, fused with an exact "
            "match on identifiers). Each result gives path:first-last line and "
            "its symbol, so the file can be read at exactly that range. A few "
            "results per call; offset reads the next page. Ask with the words "
            "the code would use, or the identifiers you know. Read-only, local."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "What to find: identifiers, or what the code does",
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "Results to return (the configured maximum applies)",
                },
                "offset": {
                    "type": "integer",
                    "minimum": 0,
                    "description": "Results to skip, to read the next page. Default 0.",
                },
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        "annotations": {"readOnlyHint": True, "openWorldHint": False},
    }
]


def mcp_server_config(project_dir: Path | str) -> dict[str, Any]:
    """The stdio entry that starts ``workpilot-code`` for one project."""
    return {
        "command": sys.executable,
        "args": [
            str(_BACKEND / "runners" / "code_search_mcp.py"),
            "--project-dir",
            str(Path(project_dir).resolve()),
        ],
    }


def tool_definitions() -> list[dict[str, Any]]:
    """`tool_executor`'s shape (``parameters``) of the MCP tool schema."""
    return [
        {
            "name": tool["name"],
            "description": tool["description"],
            "parameters": tool["inputSchema"],
        }
        for tool in TOOLS
    ]


def is_code_search_tool(name: str) -> bool:
    return name == TOOL_NAME


def _count(value: Any) -> int | None:
    """A count a model sent, as an int; None when absent or unreadable."""
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def call(project_dir: Path | str, arguments: dict[str, Any], max_chars: int) -> str:
    """One `search_code` call; a bad argument comes back as the result, not raised."""
    from harness.application.code_search import search_code

    arguments = arguments if isinstance(arguments, dict) else {}
    try:
        return search_code(
            project_dir,
            str(arguments.get("query") or ""),
            offset=_count(arguments.get("offset")) or 0,
            limit=_count(arguments.get("limit")),
            max_chars=max_chars,
        )
    except ValueError as error:
        return f"Error: {error}"


async def execute_tool(
    name: str, arguments: dict[str, Any], project_dir: Path | str, max_chars: int
) -> str:
    """Run the tool off the event loop: the first call of a project builds its index."""
    if not is_code_search_tool(name):
        raise KeyError(name)
    return await asyncio.to_thread(call, project_dir, dict(arguments or {}), max_chars)
