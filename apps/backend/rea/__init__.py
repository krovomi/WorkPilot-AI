"""REA (npm ``rea-agents``): what a shipped artifact reveals, read statically.

WorkPilot runs one REA release, pinned in ``pin.json`` (`pin`), through its
CLI only: `locate` finds a Node.js that release accepts and either REA
installed at that exact version or npx to fetch it, and `runner` runs a
command from a closed list of static readers on absolute paths, without a
shell, without the backend's credentials, from a directory of its own.

Not an MCP server in the Kanban phases (240 tools, and a new tool would hold
the server for approval), and never a command that runs the target: see
docs/architecture/rea.md.
"""

from __future__ import annotations

from .locate import ReaLauncher, ReaUnavailable, locate
from .pin import Pin, load_pin, node_satisfies
from .runner import COMMANDS, ReaRun, run_rea

__all__ = [
    "COMMANDS",
    "Pin",
    "ReaLauncher",
    "ReaRun",
    "ReaUnavailable",
    "load_pin",
    "locate",
    "node_satisfies",
    "run_rea",
]
