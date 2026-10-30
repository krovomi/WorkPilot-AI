"""
MCP tool bridge for the OpenAI-compatible agent loop
====================================================

Lets the generic OpenAI-style clients (OpenAI / Google / **local LLM**) consume
configured MCP servers — the same servers the Claude SDK path already uses via
``CUSTOM_MCP_SERVERS``. Each MCP tool is surfaced as an OpenAI function
definition (namespaced ``mcp__<server>__<tool>``) and calls are routed back to
the owning MCP session.

Why this exists: ``LocalAgentClient`` (and its OpenAI/Google siblings) run a
fixed local ``ToolExecutor`` and previously ignored MCP entirely, so a local
LLM could never use e.g. the Hugging Face MCP's ``model_search`` during a task.

Server configuration is read from the canonical backend channel:
  1. ``CUSTOM_MCP_SERVERS`` env var (JSON array), and
  2. the project ``.workpilot/.env`` ``CUSTOM_MCP_SERVERS`` entry.

Each entry is ``{"id"|"name", "type": "command"|"http", ...}``:
  - command: ``command`` (+ optional ``args``)
  - http:    ``url`` (+ optional ``headers``)

A client bridges only the servers its agent type may reach
(`load_mcp_server_configs_for`): those a project adds to that agent, as on the
SDK path.

The whole bridge is best-effort: a server that fails to connect is skipped with
a warning, never breaking the agent loop.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

from core.mcp_extensions import (
    app_resource_uri,
    capture_app_view,
    is_task_handle,
    resolve_task,
    sdk_speaks_2026,
    session_options,
    visible_to_model,
)

logger = logging.getLogger(__name__)

# Namespacing keeps MCP tool names from colliding with the built-in toolset and
# tells the agent loop which calls to route to MCP. OpenAI tool names must match
# ^[A-Za-z0-9_-]+$, so server/tool ids are sanitized into that charset.
MCP_TOOL_PREFIX = "mcp__"

_VALID_TYPES = {"command", "http"}


def _sanitize(name: str) -> str:
    """Coerce an id into the OpenAI tool-name charset ([A-Za-z0-9_-])."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", name or "")


def _validate_server(entry: object) -> dict[str, Any] | None:
    """Minimal, dependency-free validation of one server config entry."""
    if not isinstance(entry, dict):
        return None
    stype = entry.get("type")
    if stype not in _VALID_TYPES:
        return None
    if stype == "command" and not isinstance(entry.get("command"), str):
        return None
    if stype == "http" and not isinstance(entry.get("url"), str):
        return None
    return entry


def _parse_custom_mcp_servers(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        logger.warning("[mcp] CUSTOM_MCP_SERVERS is not valid JSON — ignoring")
        return []
    if not isinstance(parsed, list):
        return []
    return [s for s in (_validate_server(e) for e in parsed) if s]


def _read_project_env_servers(project_dir: str | None) -> list[dict[str, Any]]:
    """Read CUSTOM_MCP_SERVERS from the project's .workpilot/.env, if present."""
    if not project_dir:
        return []
    env_path = Path(project_dir) / ".workpilot" / ".env"
    if not env_path.exists():
        return []
    try:
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("CUSTOM_MCP_SERVERS="):
                value = line.split("=", 1)[1].strip().strip("\"'")
                return _parse_custom_mcp_servers(value)
    except OSError:
        logger.debug("[mcp] could not read %s", env_path, exc_info=True)
    return []


def load_mcp_server_configs(project_dir: str | None) -> list[dict[str, Any]]:
    """Resolve configured MCP servers (env var first, then project .env)."""
    servers = _parse_custom_mcp_servers(os.environ.get("CUSTOM_MCP_SERVERS"))
    if servers:
        return servers
    return _read_project_env_servers(project_dir)


def load_mcp_server_configs_for(
    agent_type: str,
    project_dir: str | None,
    spec_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """The configured servers ``agent_type`` may reach.

    The answer `create_client` gives on the Claude SDK, in both of its steps:

    * a server must pass `_validate_custom_mcp_server` — ``id`` and ``name``,
      a bare launcher from a short list (npx, node, python, uv…), no
      interpreter flag that evaluates code, no field outside the schema. This
      bridge's own check accepted any command, so a server the SDK refuses to
      start was started here;
    * it joins a session only when `get_required_mcp_servers` keeps it for the
      type, which it does when the project adds it to that agent
      (``AGENT_MCP_<type>_ADD``, the Agent Tools panel's per-agent toggle). The
      bridge used to hand every configured server to every type — a
      `pr_reviewer` reading a hostile diff could call whatever a server wired
      up for the coder exposes.
    """
    from core.client import _validate_custom_mcp_server

    servers = [
        s
        for s in load_mcp_server_configs(project_dir)
        if _validate_custom_mcp_server(s)
    ]
    if not servers:
        return []

    from agents.tools_pkg import get_required_mcp_servers
    from core.client import load_project_mcp_config

    mcp_config = dict(load_project_mcp_config(Path(project_dir))) if project_dir else {}
    # The servers this bridge actually has — the env var may name some the
    # project's .env does not — so an ADD override can name any of them.
    mcp_config["CUSTOM_MCP_SERVERS"] = servers
    allowed = set(
        get_required_mcp_servers(agent_type, None, False, mcp_config, spec_dir=spec_dir)
    )
    return [entry for entry in servers if entry["id"] in allowed]


def _server_id(entry: dict[str, Any], index: int) -> str:
    raw = entry.get("id") or entry.get("name") or f"server{index}"
    return _sanitize(str(raw)) or f"server{index}"


def _field(obj: Any, *names: str) -> Any:
    """The first of ``names`` present on ``obj`` (attribute or key).

    The `mcp` package renamed its fields to snake_case in 2.0
    (`inputSchema` -> `input_schema`, `isError` -> `is_error`,
    `structuredContent` -> `structured_content`), and it arrives here
    unpinned, through `claude-agent-sdk`. Reading only the 1.x spelling made
    every bridged tool schema-less and every tool error read as a success on a
    2.x install — so both spellings are read.
    """
    for name in names:
        value = getattr(obj, name, None)
        if value is None and isinstance(obj, dict):
            value = obj.get(name)
        if value is not None:
            return value
    return None


def _result_to_text(result: Any) -> str:
    """Flatten an MCP CallToolResult into plain text for the agent transcript."""
    content = getattr(result, "content", None)
    if content is None and isinstance(result, dict):
        content = result.get("content")
    if not content:
        # Some servers return structured content only.
        structured = _field(result, "structuredContent", "structured_content")
        if structured is not None:
            try:
                return json.dumps(structured, ensure_ascii=False)
            except (TypeError, ValueError):
                return str(structured)
        return ""
    parts: list[str] = []
    for block in content:
        text = getattr(block, "text", None)
        if text is None and isinstance(block, dict):
            text = block.get("text")
        if text is not None:
            parts.append(str(text))
        else:
            # Non-text block (image/resource) — emit a compact marker.
            btype = getattr(block, "type", None) or (
                block.get("type") if isinstance(block, dict) else "content"
            )
            parts.append(f"[{btype}]")
    return "\n".join(parts)


class MCPToolManager:
    """Connects to configured MCP servers and bridges their tools.

    Use as an async context manager (or call ``connect()`` / ``aclose()``):

        async with MCPToolManager(project_dir, servers) as mcp:
            defs = mcp.tool_definitions()   # OpenAI function defs
            if mcp.has_tool(name):
                text = await mcp.call(name, args)
    """

    def __init__(
        self,
        project_dir: str | None,
        servers: list[dict[str, Any]] | None = None,
        *,
        spec_dir: str | Path | None = None,
    ):
        self._project_dir = project_dir
        # Where a tool's MCP App view is kept for the task panel; without
        # one, the session does not declare Apps (`core/mcp_extensions.py`).
        self._spec_dir = Path(spec_dir) if spec_dir else None
        self._servers = (
            servers if servers is not None else load_mcp_server_configs(project_dir)
        )
        self._stack: AsyncExitStack | None = None
        self._defs: list[dict[str, Any]] = []
        # full tool name -> (session, real_tool_name)
        self._route: dict[str, tuple[Any, str]] = {}
        # full tool name -> (server id, ui:// resource) for tools with a view
        self._views: dict[str, tuple[str, str]] = {}

    async def __aenter__(self) -> MCPToolManager:
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.aclose()

    async def connect(self) -> None:
        if not self._servers:
            return
        self._stack = AsyncExitStack()
        for index, cfg in enumerate(self._servers):
            sid = _server_id(cfg, index)
            try:
                session = await self._open_session(cfg)
                await _handshake(session)
                listed = await session.list_tools()
                tools = getattr(listed, "tools", None) or []
                for tool in tools:
                    tname = getattr(tool, "name", None)
                    if not tname:
                        continue
                    meta = _field(tool, "meta", "_meta")
                    if not visible_to_model(meta):
                        # MCP Apps: an app-only tool is never the agent's.
                        continue
                    full = f"{MCP_TOOL_PREFIX}{sid}__{_sanitize(tname)}"
                    view = app_resource_uri(meta)
                    if view and self._spec_dir is not None:
                        self._views[full] = (sid, view)
                    schema = _field(tool, "inputSchema", "input_schema") or {
                        "type": "object",
                        "properties": {},
                    }
                    self._defs.append(
                        {
                            "name": full,
                            "description": (
                                getattr(tool, "description", None)
                                or f"{tname} (MCP: {sid})"
                            ),
                            "parameters": schema,
                        }
                    )
                    self._route[full] = (session, tname)
                logger.info(
                    "[mcp] connected to '%s' — %d tool(s) bridged", sid, len(tools)
                )
            except Exception as e:  # noqa: BLE001 — one bad server must not break the loop
                logger.warning("[mcp] could not connect to server '%s': %s", sid, e)

    async def _open_session(self, cfg: dict[str, Any]) -> Any:
        """Open and enter an MCP ClientSession for one server config."""
        from mcp import ClientSession  # noqa: PLC0415

        assert self._stack is not None
        if cfg.get("type") == "http":
            from mcp.client.streamable_http import (  # noqa: PLC0415
                streamablehttp_client,
            )

            transport = await self._stack.enter_async_context(
                streamablehttp_client(cfg["url"], headers=cfg.get("headers"))
            )
            # (read, write, get_session_id)
            read, write = transport[0], transport[1]
        else:  # command / stdio
            from mcp import StdioServerParameters  # noqa: PLC0415
            from mcp.client.stdio import stdio_client  # noqa: PLC0415

            params = StdioServerParameters(
                command=cfg["command"],
                args=cfg.get("args", []) or [],
                env={**os.environ, **(cfg.get("env") or {})},
            )
            read, write = await self._stack.enter_async_context(stdio_client(params))

        return await self._stack.enter_async_context(
            ClientSession(
                read, write, **session_options(apps=self._spec_dir is not None)
            )
        )

    def tool_definitions(self) -> list[dict[str, Any]]:
        return list(self._defs)

    def has_tool(self, name: str) -> bool:
        return name in self._route

    async def call(self, name: str, arguments: dict[str, Any]) -> str:
        session, real = self._route[name]
        if sdk_speaks_2026():
            result = await session.call_tool(real, arguments or {}, allow_claimed=True)
        else:
            result = await session.call_tool(real, arguments or {})
        if is_task_handle(result):
            # MCP Tasks: the server runs it in the background; wait for it.
            result = await resolve_task(session, result)
        await self.capture_view(name, arguments, result)
        if _field(result, "isError", "is_error"):
            return f"MCP tool error: {_result_to_text(result) or name}"
        return _result_to_text(result)

    def connected(self) -> bool:
        """Whether any server answered with its tools."""
        return bool(self._route)

    def view_tools(self) -> frozenset[str]:
        """The full names of the bridged tools that name an MCP App view."""
        return frozenset(self._views)

    async def capture_view(
        self, name: str, arguments: dict[str, Any] | None, result: Any
    ) -> str | None:
        """Keep the view of a call to `name` for the task panel, if it has one.

        `result` is the call's result, whoever made the call: this manager
        (`call`), or Claude Code on the Agent SDK path (`make_app_view_hook`).
        """
        view = self._views.get(name)
        if view is None or self._spec_dir is None:
            return None
        session, real = self._route[name]
        return await capture_app_view(
            session,
            spec_dir=self._spec_dir,
            server=view[0],
            tool=real,
            resource_uri=view[1],
            arguments=arguments or {},
            result=result,
        )

    async def aclose(self) -> None:
        if self._stack is not None:
            try:
                await self._stack.aclose()
            except Exception:  # noqa: BLE001 — best-effort teardown
                logger.debug("[mcp] error during teardown", exc_info=True)
            self._stack = None
        self._defs.clear()
        self._route.clear()
        self._views.clear()


# How long the Agent SDK path may hold a tool's result to keep its view: one
# server started, its tools listed, the view read. The agent waits this long
# at most, and only for a server named in CUSTOM_MCP_SERVERS.
APP_VIEW_CAPTURE_TIMEOUT = 20.0

# The fields of a CUSTOM_MCP_SERVERS entry Claude Code starts a server with
# (`core.client._custom_servers`); the side session starts it the same way.
_SDK_SERVER_FIELDS = ("id", "name", "type", "command", "args", "url", "headers")


def _sdk_tool_result(response: Any) -> dict[str, Any]:
    """Claude Code's ``tool_response`` for an MCP tool, as a ``CallToolResult``."""
    if isinstance(response, Mapping) and "content" in response:
        return dict(response)
    if isinstance(response, list):
        return {"content": response}
    text = "" if response is None else str(response)
    return {"content": [{"type": "text", "text": text}]}


def make_app_view_hook(
    spec_dir: str | Path, servers: list[dict[str, Any]]
) -> Callable[..., Awaitable[dict[str, Any]]]:
    """A PostToolUse hook that keeps MCP App views on the Claude Agent SDK path (IA4).

    There Claude Code is the MCP client: it calls the tool, and neither knows
    nor shows the tool's view. After a call to one of `servers` (the
    project's CUSTOM_MCP_SERVERS this session started), the hook opens its own
    short session to the same server, lists its tools once, and for a tool
    that names a view reads that view and keeps it with the call's input and
    result, exactly as `MCPToolManager.call` does on the WorkPilot loop.

    The side session is a second start of the server: it lists tools and
    reads a resource, never calls a tool. It never changes the result the
    agent reads (the hook returns nothing), it is bounded by
    `APP_VIEW_CAPTURE_TIMEOUT`, and a server that fails is skipped.
    """
    configs = {
        _server_id(cfg, index): {k: cfg[k] for k in _SDK_SERVER_FIELDS if k in cfg}
        for index, cfg in enumerate(servers)
    }
    # server id -> the tools that name a view, once the server has answered
    view_tools: dict[str, frozenset[str]] = {}

    async def _capture(sid: str, name: str, arguments: Any, result: Any) -> None:
        async with MCPToolManager(None, [configs[sid]], spec_dir=spec_dir) as mcp:
            if not mcp.connected():
                return
            view_tools[sid] = mcp.view_tools()
            await mcp.capture_view(
                name, arguments if isinstance(arguments, dict) else {}, result
            )

    async def _hook(
        input_data: dict[str, Any],
        tool_use_id: str | None = None,
        context: Any | None = None,
    ) -> dict[str, Any]:
        name = str(input_data.get("tool_name") or "")
        if not name.startswith(MCP_TOOL_PREFIX):
            return {}
        sid = name[len(MCP_TOOL_PREFIX) :].split("__", 1)[0]
        if sid not in configs or name not in view_tools.get(sid, frozenset({name})):
            return {}
        try:
            async with asyncio.timeout(APP_VIEW_CAPTURE_TIMEOUT):
                await _capture(
                    sid,
                    name,
                    input_data.get("tool_input"),
                    _sdk_tool_result(input_data.get("tool_response")),
                )
        except (ImportError, OSError, RuntimeError, TimeoutError, ValueError) as exc:
            logger.debug("[mcp] app view for %s not kept: %s", name, exc)
        return {}

    return _hook


async def _handshake(session: Any) -> None:
    """``server/discover`` first (MCP 2026-07-28), ``initialize`` for any other server.

    The SDK's own connect-time policy: anything that is not positive evidence
    of a 2026-07-28 server falls back to the handshake. An older SDK only
    has the handshake.
    """
    if not sdk_speaks_2026():
        await session.initialize()
        return
    from mcp.client._probe import negotiate_auto  # noqa: PLC0415

    await negotiate_auto(session)
