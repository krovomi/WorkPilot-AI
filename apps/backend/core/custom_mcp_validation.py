"""Validation of the custom MCP servers a project declares (`CUSTOM_MCP_SERVERS`).

`core.client` builds the SDK config only from servers that pass
`validate_custom_mcp_server`; `core.mcp_tools` applies the same check to the
WorkPilot loop. The main process mirrors the `env` rules in `mcp-handlers.ts`
(`isMcpEnvSafe`).
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)


#: Environment variables a custom MCP server may never set: they load code into
#: the process (dynamic linker, runtime loaders, shell start-up files) or point
#: its package manager somewhere else. The same names
#: `claude-code-settings/env-sanitizer.ts` refuses from a repository, plus the
#: package-manager switches that would make `npx`/`uvx` fetch another package.
MCP_SERVER_ENV_DENYLIST = frozenset(
    {
        "PATH",
        "NODE_OPTIONS",
        "NODE_PATH",
        "ELECTRON_RUN_AS_NODE",
        "PYTHONPATH",
        "PYTHONSTARTUP",
        "PYTHONHOME",
        "PYTHONINSPECT",
        "PYTHONUSERBASE",
        "PERL5LIB",
        "PERL5OPT",
        "RUBYLIB",
        "RUBYOPT",
        "BASH_ENV",
        "ENV",
        "ZDOTDIR",
        "INPUTRC",
        "CDPATH",
        "JAVA_TOOL_OPTIONS",
        "_JAVA_OPTIONS",
        "COMSPEC",
        "SHELL",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "ANTHROPIC_API_KEY",
    }
)
_MCP_SERVER_ENV_DENIED_PREFIXES = (
    "LD_",
    "DYLD_",
    "NPM_CONFIG_",
    "UV_",
    "PIP_",
    "YARN_",
    "PNPM_",
)
_MCP_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


def valid_mcp_server_env(env: object) -> bool:
    """`env` of a command-type custom MCP server: names and values it may set.

    A string-to-string map of at most 32 entries, each name a plain identifier
    outside `MCP_SERVER_ENV_DENYLIST` and its prefixes, each value without a
    NUL and under 8 KiB. The catalog puts an API key here (`SENTRY_ACCESS_TOKEN`,
    `NOTION_TOKEN`…), never something that changes what the launcher runs.
    """
    if not isinstance(env, dict) or len(env) > 32:
        logger.warning("Custom MCP server 'env' must be a map of at most 32 entries")
        return False
    for name, value in env.items():
        if not isinstance(name, str) or not _MCP_ENV_NAME_RE.match(name):
            logger.warning("Rejected MCP server env name %r", name)
            return False
        upper = name.upper()
        if upper in MCP_SERVER_ENV_DENYLIST or upper.startswith(
            _MCP_SERVER_ENV_DENIED_PREFIXES
        ):
            logger.warning("Rejected MCP server env variable %s", name)
            return False
        if not isinstance(value, str) or "\x00" in value or len(value) > 8192:
            logger.warning("Rejected value of MCP server env variable %s", name)
            return False
    return True


def validate_custom_mcp_server(server: dict) -> bool:
    """
    Validate a custom MCP server configuration for security.

    Ensures only expected fields with valid types are present.
    Rejects configurations that could lead to command injection.

    Args:
        server: Dict representing a custom MCP server configuration

    Returns:
        True if valid, False otherwise
    """
    if not isinstance(server, dict):
        return False

    # Required fields
    required_fields = {"id", "name", "type"}
    if not all(field in server for field in required_fields):
        logger.warning(
            f"Custom MCP server missing required fields: {required_fields - server.keys()}"
        )
        return False

    # Validate field types
    if not isinstance(server.get("id"), str) or not server["id"]:
        return False
    if not isinstance(server.get("name"), str) or not server["name"]:
        return False
    # FIX: Changed from ('command', 'url') to ('command', 'http') to match actual usage
    if server.get("type") not in ("command", "http"):
        logger.warning(f"Invalid MCP server type: {server.get('type')}")
        return False

    # Allowlist of safe executable commands for MCP servers
    # Only allow known package managers and interpreters - NO shell commands
    SAFE_COMMANDS = {
        "npx",
        "npm",
        "node",
        "python",
        "python3",
        "uv",
        "uvx",
    }

    # Blocklist of dangerous shell commands that should never be allowed
    DANGEROUS_COMMANDS = {
        "bash",
        "sh",
        "cmd",
        "powershell",
        "pwsh",  # PowerShell Core
        "/bin/bash",
        "/bin/sh",
        "/bin/zsh",
        "/usr/bin/bash",
        "/usr/bin/sh",
        "zsh",
        "fish",
    }

    # Dangerous interpreter flags that allow arbitrary code execution
    # Covers Python (-e, -c, -m, -p), Node.js (--eval, --print, loaders), and general
    DANGEROUS_FLAGS = {
        "--eval",
        "-e",
        "-c",
        "--exec",
        "-m",  # Python module execution
        "-p",  # Python eval+print
        "--print",  # Node.js print
        "--input-type=module",  # Node.js ES module mode
        "--experimental-loader",  # Node.js custom loaders
        "--require",  # Node.js require injection
        "-r",  # Node.js require shorthand
    }

    # Type-specific validation
    if server["type"] == "command":
        if not isinstance(server.get("command"), str) or not server["command"]:
            logger.warning("Command-type MCP server missing 'command' field")
            return False

        # SECURITY FIX: Validate command is in safe list and not in dangerous list
        command = server.get("command", "")

        # Reject paths - commands must be bare names only (no / or \)
        # This prevents path traversal like '/custom/malicious' or './evil'
        if "/" in command or "\\" in command:
            logger.warning(
                f"Rejected command with path in MCP server: {command}. "
                f"Commands must be bare names without path separators."
            )
            return False

        if command in DANGEROUS_COMMANDS:
            logger.warning(
                f"Rejected dangerous command in MCP server: {command}. "
                f"Shell commands are not allowed for security reasons."
            )
            return False

        if command not in SAFE_COMMANDS:
            logger.warning(
                f"Rejected unknown command in MCP server: {command}. "
                f"Only allowed commands: {', '.join(sorted(SAFE_COMMANDS))}"
            )
            return False

        # Validate args is a list of strings if present
        if "args" in server:
            if not isinstance(server["args"], list):
                return False
            if not all(isinstance(arg, str) for arg in server["args"]):
                return False
            # Check for dangerous interpreter flags that allow code execution
            for arg in server["args"]:
                if arg in DANGEROUS_FLAGS:
                    logger.warning(
                        f"Rejected dangerous flag '{arg}' in MCP server args. "
                        f"Interpreter code execution flags are not allowed."
                    )
                    return False
        if "env" in server and not valid_mcp_server_env(server["env"]):
            return False
    elif server["type"] == "http":
        if not isinstance(server.get("url"), str) or not server["url"]:
            logger.warning("HTTP-type MCP server missing 'url' field")
            return False
        # Validate headers is a dict of strings if present
        if "headers" in server:
            if not isinstance(server["headers"], dict):
                return False
            if not all(
                isinstance(k, str) and isinstance(v, str)
                for k, v in server["headers"].items()
            ):
                return False

    # Optional description must be string if present
    if "description" in server and not isinstance(server.get("description"), str):
        return False

    # Reject any unexpected fields that could be exploited
    allowed_fields = {
        "id",
        "name",
        "type",
        "command",
        "args",
        "url",
        "headers",
        "env",
        "description",
    }
    if server["type"] == "http" and "env" in server:
        logger.warning("HTTP-type MCP server cannot carry 'env'")
        return False
    unexpected_fields = set(server.keys()) - allowed_fields
    if unexpected_fields:
        logger.warning(f"Custom MCP server has unexpected fields: {unexpected_fields}")
        return False

    return True
