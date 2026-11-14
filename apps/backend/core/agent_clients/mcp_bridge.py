"""The project's MCP servers, bridged into a WorkPilot loop session.

The providers the WorkPilot loop drives (OpenAI and its compatibles, Gemini
API, local models, GitHub Copilot) have no MCP client of their own: WorkPilot
connects to the servers this agent type may reach and offers their tools in
its own tool set (`core.mcp_tools.MCPToolManager`). Only the approved tools of
a pinned server are bridged (docs/architecture/mcp-pins.md); a delegated child
bridges nothing, its tools are its role's.
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

__all__ = ["McpBridgeMixin"]


class McpBridgeMixin:
    """`_bridge_mcp_tools` and `_close_mcp_bridge` for a loop client."""

    _mcp_manager: Any = None

    def _bridge_project_dir(self) -> str | None:
        return getattr(self, "_project_dir", None) or getattr(self, "cwd", None)

    async def _bridge_mcp_tools(self) -> list[dict[str, Any]]:
        """The tools of the configured MCP servers, bridged for this session.

        Only the servers this type may reach: the same per-agent answer the
        Claude SDK gets from `create_client`. Best-effort: an MCP error never
        fails client setup.
        """
        project_dir = self._bridge_project_dir()
        label = type(self).__name__
        if getattr(self, "delegation_scope", None) is not None or not project_dir:
            return []
        try:
            from core.mcp_tools import MCPToolManager, load_mcp_server_configs_for

            spec_dir = getattr(self, "_spec_dir", None)
            servers = load_mcp_server_configs_for(
                getattr(self, "_agent_type", "coder"), project_dir, spec_dir
            )
            if servers:
                manager = MCPToolManager(project_dir, servers, spec_dir=spec_dir)
                await manager.connect()
                mcp_defs = manager.tool_definitions()
                if mcp_defs:
                    self._mcp_manager = manager
                    logger.info(
                        f"[{label}] MCP enabled: {len(mcp_defs)} tool(s) "
                        f"from {len(servers)} server(s)"
                    )
                    return mcp_defs
                await manager.aclose()
        except Exception as e:  # noqa: BLE001 — MCP must never block client setup
            logger.warning(f"[{label}] MCP bridge unavailable: {e}")
        return []

    async def _close_mcp_bridge(self) -> None:
        if self._mcp_manager is not None:
            await self._mcp_manager.aclose()
            self._mcp_manager = None
