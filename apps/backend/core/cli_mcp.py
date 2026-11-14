"""The project's custom MCP servers, handed to the agents that run as a CLI.

Codex, OpenCode and the ACP agents (Gemini CLI…) open an MCP server
themselves, as Claude Code does on the SDK path: WorkPilot cannot hide one
tool of a server it hands them. So they get exactly what the Claude SDK gets
(`core.mcp_pinning`):

* the servers `core.mcp_tools.load_mcp_server_configs_for` keeps for the
  agent type: validated (`core.custom_mcp_validation`), and added to that
  agent in the project (``AGENT_MCP_<type>_ADD``);
* and among those, only a server whose every listed tool is the one the person
  approved (`mcp_pins`). A server never approved, changed, or unreachable is
  not started.

Each CLI then gets them in its own words, never through a shell and never with
a value on the command line that the launcher could parse:

* **Codex**: ``-c mcp_servers.<id>.…`` overrides (TOML). The server's
  environment and its HTTP headers travel in the Codex process environment,
  named by ``env_vars`` / ``env_http_headers``, so no secret is on a command
  line. A value outside a plain character set (a space, a quote, ``&``, ``%``)
  could change what ``cmd.exe`` runs for an npm ``.cmd`` launcher: that server
  is left out, and the log says so.
* **OpenCode**: the ``mcp`` block of ``OPENCODE_CONFIG_CONTENT``, the inline
  configuration OpenCode loads last.
* **ACP**: ``mcpServers`` of ``session/new``; an HTTP server only to an agent
  that declares ``mcpCapabilities.http``.

pi has no MCP client, and the WorkPilot loop (OpenAI, Copilot, Gemini API,
local models) bridges the servers itself. See docs/architecture/rea.md (lot E).
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "OPENCODE_CONFIG_ENV",
    "acp_mcp_servers",
    "cli_mcp_servers",
    "codex_mcp_overrides",
    "opencode_config_content",
]

OPENCODE_CONFIG_ENV = "OPENCODE_CONFIG_CONTENT"
#: An id, a launcher argument, a URL: what may reach a Codex command line.
_PLAIN = re.compile(r"^[A-Za-z0-9._:/@#+=,~-]+$")
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")
_HEADER = re.compile(r"^[A-Za-z0-9-]{1,64}$")


def cli_mcp_servers(
    agent_type: str,
    project_dir: str | Path | None,
    spec_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """The custom servers this agent type may start in a CLI. Never raises."""
    if not project_dir:
        return []
    try:
        from core.mcp_pinning import pin_verdicts, probe_tools
        from core.mcp_tools import load_mcp_server_configs_for

        servers = load_mcp_server_configs_for(
            agent_type, str(project_dir), spec_dir=spec_dir
        )
        if not servers:
            return []
        verdicts = pin_verdicts(
            project_dir, [(cfg, probe_tools(project_dir, cfg)) for cfg in servers]
        )
    except (OSError, ValueError, ImportError, RuntimeError) as exc:
        logger.warning("[cli-mcp] custom MCP servers not handed to the CLI: %s", exc)
        return []
    return [
        cfg
        for cfg in servers
        if (v := verdicts.get(str(cfg.get("id")))) is not None and v.exposed
    ]


def _str_map(value: object) -> dict[str, str]:
    if not isinstance(value, Mapping):
        return {}
    return {str(k): str(v) for k, v in value.items()}


def _skip(server: Mapping[str, Any], cli: str, why: str) -> None:
    logger.warning(
        "[cli-mcp] MCP server '%s' not started in %s: %s", server.get("id"), cli, why
    )


def _toml(value: str) -> str:
    # A plain value (`_PLAIN`) needs no escape inside a TOML basic string.
    return f'"{value}"'


def codex_mcp_overrides(
    servers: Sequence[Mapping[str, Any]],
    base_env: Mapping[str, str] | None = None,
) -> tuple[list[str], dict[str, str]]:
    """``-c`` overrides for ``codex exec``, and the variables they read.

    The variables join the Codex process's own environment (``base_env``): a
    server that would replace one of them (``OPENAI_API_KEY``, ``PATH``) is
    left out rather than change what Codex itself runs with.
    """
    taken = set(base_env or ())
    args: list[str] = []
    env: dict[str, str] = {}
    for index, server in enumerate(servers):
        sid = str(server.get("id") or "")
        if not _ID.match(sid):
            _skip(server, "Codex", "its id is not a plain name")
            continue
        key = f"mcp_servers.{sid}"
        if server.get("type", "command") == "http":
            url = str(server.get("url") or "")
            headers = _str_map(server.get("headers"))
            if not _PLAIN.match(url) or not all(_HEADER.match(h) for h in headers):
                _skip(server, "Codex", "its URL or a header name is not plain")
                continue
            entry = [f"{key}.url={_toml(url)}"]
            if headers:
                names = {
                    h: f"WORKPILOT_MCP_SECRET_{index}_{n}"
                    for n, h in enumerate(headers)
                }
                env.update({names[h]: v for h, v in headers.items()})
                table = ",".join(f"{_toml(h)}={_toml(n)}" for h, n in names.items())
                entry.append(f"{key}.env_http_headers={{{table}}}")
        else:
            command = str(server.get("command") or "npx")
            argv = [str(a) for a in server.get("args") or []]
            variables = _str_map(server.get("env"))
            if not all(_PLAIN.match(v) for v in [command, *argv]) or not all(
                _ENV_NAME.match(n) for n in variables
            ):
                _skip(server, "Codex", "a launcher argument is not plain")
                continue
            clash = sorted(
                n for n, v in variables.items() if n in taken or env.get(n, v) != v
            )
            if clash:
                _skip(server, "Codex", f"it would replace the value of {clash[0]}")
                continue
            entry = [
                f"{key}.command={_toml(command)}",
                f"{key}.args=[{','.join(_toml(a) for a in argv)}]",
            ]
            if variables:
                env.update(variables)
                names = ",".join(_toml(n) for n in sorted(variables))
                entry.append(f"{key}.env_vars=[{names}]")
        for override in entry:
            args += ["-c", override]
    return args, env


def opencode_config_content(
    servers: Sequence[Mapping[str, Any]], current: str | None = None
) -> str | None:
    """``OPENCODE_CONFIG_CONTENT`` with these servers in its ``mcp`` block."""
    if not servers:
        return current
    try:
        config = json.loads(current) if current else {}
    except ValueError:
        config = {}
    config = config if isinstance(config, dict) else {}
    block = config.get("mcp") if isinstance(config.get("mcp"), dict) else {}
    for server in servers:
        sid = str(server.get("id") or "")
        if not _ID.match(sid):
            _skip(server, "OpenCode", "its id is not a plain name")
            continue
        if server.get("type", "command") == "http":
            entry: dict[str, Any] = {
                "type": "remote",
                "url": str(server.get("url") or ""),
                "enabled": True,
            }
            if headers := _str_map(server.get("headers")):
                entry["headers"] = headers
        else:
            entry = {
                "type": "local",
                "command": [
                    str(server.get("command") or "npx"),
                    *(str(a) for a in server.get("args") or []),
                ],
                "enabled": True,
            }
            if variables := _str_map(server.get("env")):
                entry["environment"] = variables
        block[sid] = entry
    config["mcp"] = block
    return json.dumps(config, separators=(",", ":"))


def acp_mcp_servers(
    servers: Sequence[Mapping[str, Any]], capabilities: Mapping[str, Any]
) -> list[dict[str, Any]]:
    """``mcpServers`` for ``session/new``, in the transports the agent declared."""
    declared = capabilities.get("mcpCapabilities")
    http = isinstance(declared, Mapping) and declared.get("http") is True
    out: list[dict[str, Any]] = []
    for server in servers:
        sid = str(server.get("id") or "")
        if server.get("type", "command") == "http":
            if not http:
                _skip(server, "the ACP agent", "it does not declare MCP over HTTP")
                continue
            out.append(
                {
                    "type": "http",
                    "name": sid,
                    "url": str(server.get("url") or ""),
                    "headers": [
                        {"name": k, "value": v}
                        for k, v in _str_map(server.get("headers")).items()
                    ],
                }
            )
        else:
            out.append(
                {
                    "name": sid,
                    "command": str(server.get("command") or "npx"),
                    "args": [str(a) for a in server.get("args") or []],
                    "env": [
                        {"name": k, "value": v}
                        for k, v in _str_map(server.get("env")).items()
                    ],
                }
            )
    return out
