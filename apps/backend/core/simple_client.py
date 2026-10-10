"""
Simple Claude SDK Client Factory
================================

Factory for creating minimal Claude SDK clients for single-turn utility operations
like commit message generation, merge conflict resolution, and batch analysis.

These clients install no security hook, so they serve only agent types that
declare neither a write nor a shell tool (`hooked_grants`); anything else is
refused. Use `create_client()` from `core.client` for full agent sessions with
security. This module and `core.client` are the only places that build
`ClaudeAgentOptions` (`tests/test_sdk_options_factories.py`).

Example usage:
    from core.simple_client import create_simple_client

    # For commit message generation (text-only, no tools)
    client = create_simple_client(agent_type="commit_message")

    # For merge conflict resolution (text-only, no tools)
    client = create_simple_client(agent_type="merge_resolver")

    # For insights extraction (read tools only)
    client = create_simple_client(agent_type="insights", cwd=project_dir)
"""

import logging
import os
from pathlib import Path

from agents.tools_pkg import (
    get_agent_config,
    get_default_thinking_level,
    hooked_grants,
    mcp_tools_for_servers,
    undeclared_builtin_tools,
)
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

# BUG FIX: Monkey-patch SDK message parser to handle unknown message types
# (e.g. "rate_limit_event") gracefully. Mirrors the same patch in core/client.py
# so that simple_client users are also protected.
try:
    import claude_agent_sdk._internal.message_parser as _sdk_msg_parser
    from claude_agent_sdk.types import SystemMessage as _SDKSystemMessage

    _original_parse_message = _sdk_msg_parser.parse_message

    def _patched_parse_message(data):
        try:
            return _original_parse_message(data)
        except Exception as exc:
            if "Unknown message type" in str(exc):
                msg_type = (
                    data.get("type", "unknown") if isinstance(data, dict) else "unknown"
                )
                logging.getLogger(__name__).warning(
                    "SDK received unknown message type '%s' — skipping gracefully",
                    msg_type,
                )
                return _SDKSystemMessage(subtype=msg_type, data=data)
            raise

    _sdk_msg_parser.parse_message = _patched_parse_message
except Exception:
    pass
from core.auth import (
    configure_sdk_authentication,
    get_sdk_env_vars,
)
from core.platform import validate_cli_path
from phase_config import get_thinking_budget

logger = logging.getLogger(__name__)


def create_simple_client(
    agent_type: str = "merge_resolver",
    model: str = "claude-haiku-4-5-20251001",
    system_prompt: str | None = None,
    cwd: Path | None = None,
    max_turns: int = 1,
    max_thinking_tokens: int | None = None,
    output_format: dict | None = None,
    mcp_servers: dict[str, dict] | None = None,
) -> ClaudeSDKClient:
    """
    Create a minimal Claude SDK client for single-turn utility operations.

    This factory creates lightweight clients without MCP servers, security hooks,
    or full permission configurations. Use for text-only analysis tasks.

    Args:
        agent_type: Agent type from AGENT_CONFIGS. Determines available tools.
                   Common utility types:
                   - "merge_resolver" - Text-only merge conflict analysis
                   - "commit_message" - Text-only commit message generation
                   - "insights" - Read-only code insight extraction
                   - "batch_analysis" - Read-only batch issue analysis
                   - "batch_validation" - Read-only validation
        model: Claude model to use (defaults to Haiku for fast/cheap operations)
        system_prompt: Optional custom system prompt (for specialized tasks)
        cwd: Working directory for file operations (optional)
        max_turns: Maximum conversation turns (default: 1 for single-turn)
        max_thinking_tokens: Override thinking budget (None = use agent default from
                            AGENT_CONFIGS, converted using phase_config.THINKING_BUDGET_MAP)
        mcp_servers: Connection details for MCP servers, keyed by server name.
                    Only servers the type declares in its `mcp_servers` are
                    accepted, and their tools are approved; the type decides
                    what the session reaches, the caller says how.

    Returns:
        Configured ClaudeSDKClient for single-turn operations

    Raises:
        ValueError: If agent_type is not found in AGENT_CONFIGS, declares a
            tool only `create_client` guards (Write, Edit, Bash), or is handed
            an MCP server it does not declare
    """
    # Get agent configuration (raises ValueError if unknown type)
    config = get_agent_config(agent_type)

    # No hook is installed here: no `bash_security_hook`, no write-path guard,
    # no guardrails. A type that declares a command or a write would run them
    # unchecked, so it belongs to `create_client`. Refused before anything
    # else is configured, so the mistake surfaces at the call site, not as an
    # authentication or offline-policy error.
    if hooked := hooked_grants(agent_type):
        raise ValueError(
            f"agent_type '{agent_type}' declares {', '.join(hooked)}, which only "
            "create_client() hands over behind its security hooks"
        )

    # Built-in tools from the declaration, and the tools of the MCP servers the
    # caller connects — each of which the type must declare.
    allowed_tools = list(config.get("tools", []))
    if mcp_servers:
        undeclared = sorted(set(mcp_servers) - set(config.get("mcp_servers", [])))
        if undeclared:
            raise ValueError(
                f"agent_type '{agent_type}' does not declare the MCP server(s) "
                f"{', '.join(undeclared)}"
            )
        allowed_tools.extend(mcp_tools_for_servers(list(mcp_servers)))

    from core.offline_policy import guard_cloud_client

    guard_cloud_client(cwd or Path.cwd(), os.environ.get("AUTO_CLAUDE_PROJECT_DIR"))

    # Get environment variables for SDK (including CLAUDE_CONFIG_DIR if set)
    sdk_env = get_sdk_env_vars()

    # Get the config dir for profile-specific credential lookup
    # CLAUDE_CONFIG_DIR enables per-profile Keychain entries with SHA256-hashed service names
    config_dir = sdk_env.get("CLAUDE_CONFIG_DIR")

    # Configure SDK authentication (OAuth or API profile mode)
    configure_sdk_authentication(config_dir)

    # Determine thinking budget using the single source of truth (phase_config.py)
    if max_thinking_tokens is None:
        thinking_level = get_default_thinking_level(agent_type)
        max_thinking_tokens = get_thinking_budget(thinking_level)

    # Build options dict
    # Note: SDK bundles its own CLI, so no cli_path detection needed
    options_kwargs = {
        "model": model,
        "system_prompt": system_prompt,
        "allowed_tools": allowed_tools,
        "max_turns": max_turns,
        "cwd": str(cwd.resolve()) if cwd else None,
        "env": sdk_env,
    }

    if mcp_servers:
        options_kwargs["mcp_servers"] = mcp_servers

    # A simple client loads the user's and the project's own settings files,
    # whose allow rules can grant what the type does not declare: deny it,
    # as `create_client` does. `commit_message` and `merge_resolver` declare
    # no tool at all.
    if denied := undeclared_builtin_tools(agent_type):
        options_kwargs["disallowed_tools"] = denied

    # Only add max_thinking_tokens if not None (Haiku doesn't support extended thinking)
    if max_thinking_tokens is not None:
        options_kwargs["max_thinking_tokens"] = max_thinking_tokens

    # Structured output schema (validated + auto-retried by the SDK).
    # See: code.claude.com/docs/en/agent-sdk/structured-outputs
    if output_format:
        options_kwargs["output_format"] = output_format

    # Optional: Allow CLI path override via environment variable
    env_cli_path = os.environ.get("CLAUDE_CLI_PATH")
    if env_cli_path and validate_cli_path(env_cli_path):
        options_kwargs["cli_path"] = env_cli_path
        logger.info(f"Using CLAUDE_CLI_PATH override: {env_cli_path}")

    return ClaudeSDKClient(options=ClaudeAgentOptions(**options_kwargs))
