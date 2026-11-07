"""One tool server's JSON-RPC answers, in both eras of the protocol.

WorkPilot's servers are written against the protocol, not an SDK (one stdio
line per message). This class answers for one of them:

- a handshake-era request (no protocol ``_meta``) exactly as before:
  ``initialize``, ``ping``, ``tools/list``, ``tools/call``, and, for a server
  that has some, ``resources/list``, ``resources/templates/list`` and
  ``resources/read``;
- a 2026-07-28 request: ``server/discover``, the same methods with
  ``resultType``, and, for a client that declares
  ``io.modelcontextprotocol/tasks`` on that request, a long tool returned as a
  task, read with ``tasks/get`` and stopped with ``tasks/cancel``.

A client that does not declare the extension always gets the tool's result
itself: a task is never returned to a client that cannot read it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from .progress import Notify, bind_progress
from .store import TaskStore
from .wire import (
    INVALID_PARAMS,
    METHOD_NOT_FOUND,
    MISSING_REQUIRED_CLIENT_CAPABILITY,
    MODERN_VERSION,
    SERVER_INFO_META,
    TASKS_EXTENSION,
    UNSUPPORTED_PROTOCOL_VERSION,
    WireError,
    declares_extension,
    request_meta,
    request_version,
)

CallTool = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]

#: JSON-RPC's code for a resource the server does not have (MCP's own).
RESOURCE_NOT_FOUND = -32002

_RESOURCE_METHODS = ("resources/list", "resources/templates/list", "resources/read")


@dataclass(frozen=True)
class Resources:
    """A server's resources: what it lists, how it reads one, its URI templates.

    ``read`` answers ``{"contents": [...]}``, or None for a URI that is not
    one of the server's.
    """

    listing: Callable[[], Awaitable[list[dict[str, Any]]]]
    read: Callable[[str], Awaitable[dict[str, Any] | None]]
    templates: list[dict[str, Any]] = field(default_factory=list)


_TASK_METHODS = ("tasks/get", "tasks/update", "tasks/cancel")


class ToolServer:
    def __init__(
        self,
        *,
        name: str,
        version: str,
        instructions: str,
        tools: list[dict[str, Any]],
        call: CallTool,
        legacy_versions: tuple[str, ...],
        task_tools: frozenset[str] = frozenset(),
        store: TaskStore | None = None,
        resources: Resources | None = None,
    ) -> None:
        self._info = {"name": name, "version": version}
        self._instructions = instructions
        self._tools = tools
        self._names = {tool["name"] for tool in tools}
        self._call = call
        self._legacy_versions = legacy_versions
        self._task_tools = task_tools & self._names
        self.tasks = store or TaskStore()
        self._resources = resources
        self.notify: Notify | None = None
        """Writes a notification to the client, set by a transport that can
        (stdio). None means the client is never sent progress."""
        # One tool at a time, task or not: the tools share state (a browser,
        # a launched app) and ran in order before tasks existed.
        self._run_lock = asyncio.Lock()

    async def handle(self, message: dict[str, Any]) -> dict[str, Any] | None:
        """One JSON-RPC message in, at most one out (notifications get none)."""
        if "id" not in message:
            return None
        msg_id = message.get("id")
        params = message.get("params") or {}
        if not isinstance(params, dict):
            return _error(msg_id, INVALID_PARAMS, "params must be an object")
        try:
            result = await self._dispatch(str(message.get("method")), params)
        except WireError as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "error": exc.to_error()}
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    async def _dispatch(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        version = request_version(params)
        if version is None:
            return await self._legacy(method, params)
        if version != MODERN_VERSION:
            raise WireError(
                UNSUPPORTED_PROTOCOL_VERSION,
                f"unsupported protocol version {version}",
                {"supported": [MODERN_VERSION], "requested": version},
            )
        return await self._modern(method, params)

    async def _legacy(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "initialize":
            asked = params.get("protocolVersion")
            return {
                "protocolVersion": asked
                if asked in self._legacy_versions
                else self._legacy_versions[0],
                "capabilities": self._capabilities(),
                "serverInfo": self._info,
                "instructions": self._instructions,
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": self._tools}
        if method == "tools/call":
            name, arguments = self._tool_call(params)
            return await self._run(name, arguments, _progress_token(params))
        if method in _RESOURCE_METHODS:
            return await self._resource(method, params)
        if method in _TASK_METHODS:
            raise _undeclared()
        raise WireError(METHOD_NOT_FOUND, f"method not found: {method}")

    async def _modern(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        meta = {SERVER_INFO_META: self._info}
        if method == "server/discover":
            capabilities = self._capabilities()
            if self._task_tools:
                capabilities["extensions"] = {TASKS_EXTENSION: {}}
            return {
                "resultType": "complete",
                "supportedVersions": [MODERN_VERSION],
                "capabilities": capabilities,
                "instructions": self._instructions,
                "cacheScope": "private",
                "ttlMs": 0,
                "_meta": meta,
            }
        if method == "ping":
            return {"resultType": "complete", "_meta": meta}
        if method == "tools/list":
            return {
                "resultType": "complete",
                "tools": self._tools,
                "cacheScope": "private",
                "ttlMs": 0,
                "_meta": meta,
            }
        if method == "tools/call":
            name, arguments = self._tool_call(params)
            token = _progress_token(params)
            if name in self._task_tools and declares_extension(params, TASKS_EXTENSION):
                return {
                    **self.tasks.start(
                        lambda: self._run(name, arguments, token),
                        status_message=f"{name} running",
                    ),
                    "_meta": meta,
                }
            return {
                **await self._run(name, arguments, token),
                "resultType": "complete",
                "_meta": meta,
            }
        if method in _RESOURCE_METHODS:
            return {
                **await self._resource(method, params),
                "resultType": "complete",
                "_meta": meta,
            }
        if method in _TASK_METHODS:
            if not declares_extension(params, TASKS_EXTENSION):
                raise _undeclared()
            task_id = params.get("taskId")
            if method == "tasks/get":
                result = self.tasks.get(task_id)
            elif method == "tasks/update":
                result = self.tasks.update(task_id, params.get("inputResponses"))
            else:
                result = self.tasks.cancel(task_id)
            return {**result, "_meta": meta}
        raise WireError(METHOD_NOT_FOUND, f"method not found: {method}")

    def _capabilities(self) -> dict[str, Any]:
        capabilities: dict[str, Any] = {"tools": {"listChanged": False}}
        if self._resources is not None:
            capabilities["resources"] = {"listChanged": False}
        return capabilities

    async def _resource(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if self._resources is None:
            raise WireError(METHOD_NOT_FOUND, f"method not found: {method}")
        if method == "resources/list":
            return {"resources": await self._resources.listing()}
        if method == "resources/templates/list":
            return {"resourceTemplates": self._resources.templates}
        uri = params.get("uri")
        if not isinstance(uri, str) or not uri:
            raise WireError(INVALID_PARAMS, "uri must be a string")
        result = await self._resources.read(uri)
        if result is None:
            raise WireError(RESOURCE_NOT_FOUND, "resource not found", {"uri": uri})
        return result

    def _tool_call(self, params: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        name = str(params.get("name"))
        if name not in self._names:
            raise WireError(INVALID_PARAMS, f"unknown tool {name}")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise WireError(INVALID_PARAMS, "arguments must be an object")
        return name, arguments

    async def _run(
        self, name: str, arguments: dict[str, Any], token: Any = None
    ) -> dict[str, Any]:
        async with self._run_lock:
            with bind_progress(self.notify, token):
                return await self._call(name, arguments)

    async def aclose(self) -> None:
        await self.tasks.aclose()


def _progress_token(params: dict[str, Any]) -> Any:
    """The ``_meta.progressToken`` a client sends to ask for progress."""
    return request_meta(params).get("progressToken")


def _undeclared() -> WireError:
    return WireError(
        MISSING_REQUIRED_CLIENT_CAPABILITY,
        f"the request does not declare the {TASKS_EXTENSION} extension",
    )


def _error(msg_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}
