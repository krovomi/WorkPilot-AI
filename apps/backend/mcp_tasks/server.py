"""One tool server's JSON-RPC answers, in both eras of the protocol.

WorkPilot's servers are written against the protocol, not an SDK (one stdio
line per message). This class answers for one of them:

- a handshake-era request (no protocol ``_meta``) exactly as before:
  ``initialize``, ``ping``, ``tools/list``, ``tools/call``;
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
from typing import Any

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
    request_version,
)

CallTool = Callable[[str, dict[str, Any]], Awaitable[dict[str, Any]]]

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
    ) -> None:
        self._info = {"name": name, "version": version}
        self._instructions = instructions
        self._tools = tools
        self._names = {tool["name"] for tool in tools}
        self._call = call
        self._legacy_versions = legacy_versions
        self._task_tools = task_tools & self._names
        self.tasks = store or TaskStore()
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
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": self._info,
                "instructions": self._instructions,
            }
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": self._tools}
        if method == "tools/call":
            return await self._run(*self._tool_call(params))
        if method in _TASK_METHODS:
            raise _undeclared()
        raise WireError(METHOD_NOT_FOUND, f"method not found: {method}")

    async def _modern(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        meta = {SERVER_INFO_META: self._info}
        if method == "server/discover":
            capabilities: dict[str, Any] = {"tools": {"listChanged": False}}
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
            if name in self._task_tools and declares_extension(params, TASKS_EXTENSION):
                return {
                    **self.tasks.start(
                        lambda: self._run(name, arguments),
                        status_message=f"{name} running",
                    ),
                    "_meta": meta,
                }
            return {
                **await self._run(name, arguments),
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

    def _tool_call(self, params: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        name = str(params.get("name"))
        if name not in self._names:
            raise WireError(INVALID_PARAMS, f"unknown tool {name}")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, dict):
            raise WireError(INVALID_PARAMS, "arguments must be an object")
        return name, arguments

    async def _run(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        async with self._run_lock:
            return await self._call(name, arguments)

    async def aclose(self) -> None:
        await self.tasks.aclose()


def _undeclared() -> WireError:
    return WireError(
        MISSING_REQUIRED_CLIENT_CAPABILITY,
        f"the request does not declare the {TASKS_EXTENSION} extension",
    )


def _error(msg_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": code, "message": message}}
