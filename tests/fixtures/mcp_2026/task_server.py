"""A WorkPilot-style tool server for the MCP 2026-07-28 tests.

`mcp_tasks.ToolServer` over stdio, the way WorkPilot's own servers serve it:
``slow`` is returned as a task to a client that reads tasks, ``quick`` never
is, ``hang`` runs until it is cancelled (it writes a marker when it is).
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "apps" / "backend"))

from mcp_tasks import ToolServer  # noqa: E402

CANCELLED_MARKER = os.environ.get("TASK_SERVER_CANCELLED_MARKER", "")

TOOLS = [
    {
        "name": name,
        "description": name,
        "inputSchema": {"type": "object", "properties": {}},
    }
    for name in ("slow", "quick", "hang")
]


async def call(name, arguments):
    if name == "slow":
        await asyncio.sleep(1.2)
        return {"content": [{"type": "text", "text": "slow done"}], "isError": False}
    if name == "hang":
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            if CANCELLED_MARKER:
                Path(CANCELLED_MARKER).write_text("cancelled", encoding="utf-8")
            raise
    return {"content": [{"type": "text", "text": f"{name} done"}], "isError": False}


async def main():
    server = ToolServer(
        name="task-fixture",
        version="1.0.0",
        instructions="fixture",
        tools=TOOLS,
        call=call,
        legacy_versions=("2025-06-18",),
        task_tools=frozenset({"slow", "hang"}),
    )
    loop = asyncio.get_running_loop()
    try:
        while line := await loop.run_in_executor(None, sys.stdin.readline):
            if not line.strip():
                continue
            reply = await server.handle(json.loads(line))
            if reply is not None:
                sys.stdout.write(json.dumps(reply) + "\n")
                sys.stdout.flush()
    finally:
        await server.aclose()


asyncio.run(main())
