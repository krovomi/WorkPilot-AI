"""MCP 2026-07-28 for WorkPilot: the stateless core and the Tasks extension.

`ToolServer` answers for one of WorkPilot's handwritten MCP servers in both
eras of the protocol, and returns a long tool as a task to a client that
declares ``io.modelcontextprotocol/tasks``. `TaskStore` keeps those tasks.
The client side, for the providers on WorkPilot's own loop, is in
`core/mcp_tools.py`. Design: ``docs/architecture/mcp-2026.md``.

A leaf: the standard library only (``tests/test_import_contracts.py``).
"""

from .progress import bind_progress, report_progress
from .server import RESOURCE_NOT_FOUND, Resources, ToolServer
from .store import TaskStore
from .wire import (
    APP_MIME_TYPE,
    APPS_EXTENSION,
    MODERN_VERSION,
    TASKS_EXTENSION,
    TERMINAL_STATUSES,
    WireError,
    declares_extension,
    request_version,
)

__all__ = [
    "APPS_EXTENSION",
    "APP_MIME_TYPE",
    "MODERN_VERSION",
    "RESOURCE_NOT_FOUND",
    "Resources",
    "TASKS_EXTENSION",
    "TERMINAL_STATUSES",
    "TaskStore",
    "ToolServer",
    "WireError",
    "bind_progress",
    "declares_extension",
    "report_progress",
    "request_version",
]
