"""The 2026-07-28 wire vocabulary WorkPilot's MCP servers and client speak.

From 2026-07-28 a request carries its protocol version and the client's
capabilities in its own ``_meta``: there is no ``initialize`` handshake and no
session. A request without that ``_meta`` is a handshake-era one and is
answered as before.

Sources: https://modelcontextprotocol.io/specification/2026-07-28 and the
Tasks extension, https://tasks.extensions.modelcontextprotocol.io/.
"""

from __future__ import annotations

from typing import Any

MODERN_VERSION = "2026-07-28"

PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion"
CLIENT_CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities"
SERVER_INFO_META = "io.modelcontextprotocol/serverInfo"

TASKS_EXTENSION = "io.modelcontextprotocol/tasks"
APPS_EXTENSION = "io.modelcontextprotocol/ui"
APP_MIME_TYPE = "text/html;profile=mcp-app"

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})

METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
MISSING_REQUIRED_CLIENT_CAPABILITY = -32021
UNSUPPORTED_PROTOCOL_VERSION = -32022


class WireError(Exception):
    """A JSON-RPC error to answer with."""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_error(self) -> dict[str, Any]:
        error: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            error["data"] = self.data
        return error


def request_meta(params: dict[str, Any]) -> dict[str, Any]:
    meta = params.get("_meta")
    return meta if isinstance(meta, dict) else {}


def request_version(params: dict[str, Any]) -> str | None:
    """The protocol version a modern request names, None for a handshake-era one."""
    version = request_meta(params).get(PROTOCOL_VERSION_META)
    return version if isinstance(version, str) else None


def declares_extension(params: dict[str, Any], extension: str) -> bool:
    """Whether this request's client capabilities declare ``extension``.

    Declared per request: a client that declared it once is not assumed to
    have it on the next request.
    """
    capabilities = request_meta(params).get(CLIENT_CAPABILITIES_META)
    if not isinstance(capabilities, dict):
        return False
    extensions = capabilities.get("extensions")
    return isinstance(extensions, dict) and isinstance(extensions.get(extension), dict)
