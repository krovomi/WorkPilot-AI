"""
Agent Tool Permissions
======================

Manages which tools are allowed for each agent type to prevent context
pollution and accidental misuse.

Supports dynamic tool filtering based on project capabilities to optimize
context window usage. For example, Electron tools are only included for
Electron projects, not for Next.js or CLI projects.

This module now uses AGENT_CONFIGS from models.py as the single source of truth
for tool permissions. The get_allowed_tools() function remains the primary API
for backwards compatibility.
"""

from .models import (
    AGENT_CONFIGS,
    CHROME_DEVTOOLS_TOOLS,
    CONTEXT7_TOOLS,
    ELECTRON_TOOLS,
    GRAPHITI_MCP_TOOLS,
    LINEAR_TOOLS,
    PUPPETEER_TOOLS,
    VERIFY_TOOLS,
    get_agent_config,
    get_required_mcp_servers,
)
from .registry import is_tools_available


def get_allowed_tools(
    agent_type: str,
    project_capabilities: dict | None = None,
    linear_enabled: bool = False,
    mcp_config: dict | None = None,
    spec_dir=None,
) -> list[str]:
    """
    Get the list of allowed tools for a specific agent type.

    This ensures each agent only sees tools relevant to their role,
    preventing context pollution and accidental misuse.

    Uses AGENT_CONFIGS as the single source of truth for tool permissions.
    Dynamic MCP tools are added based on project capabilities and required servers.

    Args:
        agent_type: Agent type identifier (e.g., 'coder', 'planner', 'qa_reviewer')
        project_capabilities: Optional dict from detect_project_capabilities()
                            containing flags like is_electron, is_web_frontend, etc.
        linear_enabled: Whether Linear integration is enabled for this project
        mcp_config: Per-project MCP server toggles from .workpilot/.env

    Returns:
        List of allowed tool names

    Raises:
        ValueError: If agent_type is not found in AGENT_CONFIGS
    """
    # Get agent configuration (raises ValueError if unknown type)
    config = get_agent_config(agent_type)

    # Start with base tools from config
    tools = list(config.get("tools", []))

    # Get required MCP servers for this agent
    required_servers = get_required_mcp_servers(
        agent_type,
        project_capabilities,
        linear_enabled,
        mcp_config,
        spec_dir=spec_dir,
    )

    # Add workpilot tools ONLY if the MCP server is available
    # This prevents allowing tools that won't work because the server isn't running
    if "workpilot" in required_servers and is_tools_available():
        tools.extend(config.get("auto_claude_tools", []))

    # Add MCP tool names based on required servers
    tools.extend(mcp_tools_for_servers(required_servers))

    return tools


def mcp_tools_for_servers(servers: list[str]) -> list[str]:
    """
    Get the list of MCP tools for a list of required servers.

    Maps server names to their corresponding tool lists.

    Args:
        servers: List of MCP server names (e.g., ['context7', 'linear', 'electron'])

    Returns:
        List of MCP tool names for all specified servers
    """
    tools = []

    for server in servers:
        if server == "context7":
            tools.extend(CONTEXT7_TOOLS)
        elif server == "linear":
            tools.extend(LINEAR_TOOLS)
        elif server == "graphiti":
            tools.extend(GRAPHITI_MCP_TOOLS)
        elif server == "electron":
            tools.extend(ELECTRON_TOOLS)
        elif server == "puppeteer":
            tools.extend(PUPPETEER_TOOLS)
        elif server == "chrome-devtools":
            tools.extend(CHROME_DEVTOOLS_TOOLS)
        elif server == "verify":
            tools.extend(VERIFY_TOOLS)
        elif server == "brain":
            from brain.runtime import MCP_TOOL_NAMES

            tools.extend(MCP_TOOL_NAMES)
        elif server == "uiux":
            from uiux.integration import MCP_TOOL_NAMES as UIUX_TOOL_NAMES

            tools.extend(UIUX_TOOL_NAMES)
        # workpilot tools are already added via config["auto_claude_tools"]

    return tools


#: The built-in tools whose use is a capability an agent type must declare —
#: changing files, running commands, reaching the network — each with the
#: declaration that grants it. `MultiEdit` and `NotebookEdit` ride on `Edit`.
#: Reading (Read, Glob, Grep) is not guarded: every type with tools reads.
GUARDED_TOOLS: dict[str, str] = {
    "Write": "Write",
    "Edit": "Edit",
    "MultiEdit": "Edit",
    "NotebookEdit": "Edit",
    "Bash": "Bash",
    "WebFetch": "WebFetch",
    "WebSearch": "WebSearch",
}


def declared_tools(agent_type: str) -> frozenset[str] | None:
    """What an agent type declares, or ``None`` for a type nobody registered.

    ``None`` is permissive on purpose: every `agent_type` the product passes is
    registered (`test_every_literal_agent_type_is_registered` walks the AST for them),
    so an unknown one is a test or a caller outside the product, and refusing
    it everything would break those rather than protect anything.
    """
    config = AGENT_CONFIGS.get(agent_type)
    if config is None:
        return None
    return frozenset(config.get("tools", []))


def undeclared_builtin_tools(agent_type: str) -> list[str]:
    """The guarded built-in tools `agent_type` does not declare.

    This is what makes a declaration a right rather than a wish. The SDK's
    `allowed_tools` only auto-approves: a tool missing from it stays callable,
    and the settings file `create_client` writes grants Write, Edit and
    `Bash(*)` to every type. `disallowed_tools` removes a tool from the model's
    context and wins over those allow rules, so it is the list `create_client`
    passes; the non-Claude tool executor derives its own gate from the same
    declaration (`declared_tools`).
    """
    declared = declared_tools(agent_type)
    if declared is None:
        return []
    return [tool for tool, grant in GUARDED_TOOLS.items() if grant not in declared]


#: The declarations whose tools `create_client` puts behind a hook: a command
#: goes through `bash_security_hook` and the guardrails, a write through the
#: write-path guard, the guardrails and the watermark cleaner. A factory that
#: installs none of them cannot serve a type that declares one of these.
HOOKED_GRANTS: frozenset[str] = frozenset({"Write", "Edit", "Bash"})


def hooked_grants(agent_type: str) -> list[str]:
    """What `agent_type` declares that only `create_client` may hand over.

    `create_simple_client` installs no hook, so a type it serves runs every
    command and every write it declares unchecked. It refuses a type for which
    this list is not empty. An unknown type answers ``[]``, like
    `undeclared_builtin_tools`: the simple client refuses those on its own.
    """
    declared = declared_tools(agent_type)
    if declared is None:
        return []
    return sorted(declared & HOOKED_GRANTS)


def get_all_agent_types() -> list[str]:
    """
    Get all registered agent types.

    Returns:
        Sorted list of all agent type identifiers
    """
    return sorted(AGENT_CONFIGS.keys())
