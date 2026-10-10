"""
Custom MCP Tools for WorkPilot AI Agents
========================================

This module provides custom MCP tools that agents can use for reliable
operations on workpilot data structures. These tools replace prompt-based
JSON manipulation with guaranteed-correct operations.

Benefits:
- 100% reliable JSON operations (no malformed output)
- Reduced context usage (tool definitions << prompt instructions)
- Type-safe with proper error handling
- Each agent only sees tools relevant to their role via allowed_tools

Usage:
    from auto_claude_tools import create_auto_claude_mcp_server, get_allowed_tools

    # Create the MCP server
    mcp_server = create_auto_claude_mcp_server(spec_dir, project_dir)

    # Get allowed tools for a specific agent type
    allowed_tools = get_allowed_tools("coder")

    # Never build ClaudeAgentOptions yourself: `core.client.create_client` (or
    # `core.simple_client.create_simple_client`) is the one place that turns
    # a type's declaration into rights, denials and hooks.
    client = create_client(project_dir, spec_dir, model, agent_type="coder")
"""

from .models import (
    # Agent configuration registry
    AGENT_CONFIGS,
    # Base tools
    BASE_READ_TOOLS,
    BASE_WRITE_TOOLS,
    # MCP tool lists
    CONTEXT7_TOOLS,
    ELECTRON_TOOLS,
    GRAPHITI_MCP_TOOLS,
    LINEAR_TOOLS,
    PUPPETEER_TOOLS,
    # WorkPilot AI tool names
    TOOL_GET_BUILD_PROGRESS,
    TOOL_GET_SESSION_CONTEXT,
    TOOL_RECORD_DISCOVERY,
    TOOL_RECORD_GOTCHA,
    TOOL_UPDATE_QA_STATUS,
    TOOL_UPDATE_SUBTASK_STATUS,
    WEB_TOOLS,
    # Config functions
    get_agent_config,
    get_default_thinking_level,
    get_required_mcp_servers,
    is_electron_mcp_enabled,
)
from .permissions import (
    declared_tools,
    get_all_agent_types,
    get_allowed_tools,
    hooked_grants,
    mcp_tools_for_servers,
    undeclared_builtin_tools,
)
from .registry import create_auto_claude_mcp_server, is_tools_available

__all__ = [
    # Main API
    "create_auto_claude_mcp_server",
    "get_allowed_tools",
    "declared_tools",
    "undeclared_builtin_tools",
    "hooked_grants",
    "mcp_tools_for_servers",
    "is_tools_available",
    # Agent configuration registry
    "AGENT_CONFIGS",
    "get_agent_config",
    "get_required_mcp_servers",
    "get_default_thinking_level",
    "get_all_agent_types",
    # Base tool lists
    "BASE_READ_TOOLS",
    "BASE_WRITE_TOOLS",
    "WEB_TOOLS",
    # MCP tool lists
    "CONTEXT7_TOOLS",
    "LINEAR_TOOLS",
    "GRAPHITI_MCP_TOOLS",
    "ELECTRON_TOOLS",
    "PUPPETEER_TOOLS",
    # WorkPilot AI tool name constants
    "TOOL_UPDATE_SUBTASK_STATUS",
    "TOOL_GET_BUILD_PROGRESS",
    "TOOL_RECORD_DISCOVERY",
    "TOOL_RECORD_GOTCHA",
    "TOOL_GET_SESSION_CONTEXT",
    "TOOL_UPDATE_QA_STATUS",
    # Config
    "is_electron_mcp_enabled",
]
