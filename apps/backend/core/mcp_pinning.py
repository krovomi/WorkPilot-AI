"""The project's custom MCP servers, as far as their pins let them reach a session.

Two paths start a custom server (`CUSTOM_MCP_SERVERS`):

* the Claude Agent SDK, where Claude Code opens the server itself and shows
  the model every tool it lists. WorkPilot cannot filter one tool there, so a
  server reaches the session only when every tool it lists now is the one the
  person approved (`pinned_servers`). The probe is a short session of our
  own: start, list the tools, close; it never calls a tool;
* the WorkPilot loop (`core.mcp_tools.MCPToolManager`), which lists the tools
  anyway and bridges only the approved ones (`pin_verdicts`).

A server that cannot be listed is unknown: neither approved nor started. In
strict offline mode (rule S7) an HTTP server is not probed, so not started.
See docs/architecture/mcp-pins.md.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import time
from pathlib import Path

from mcp_pins import (
    APPROVED,
    PinError,
    ToolSnapshot,
    Verdict,
    config_digest,
    pins_root,
    reconcile,
)

logger = logging.getLogger(__name__)

__all__ = ["custom_servers", "pin_verdicts", "pinned_servers", "probe_tools"]

#: How long a probe may take, per server.
PROBE_TIMEOUT = 30.0
#: A build opens many sessions; one probe per server and configuration serves
#: them for this long. An approval is read again on every session.
_PROBE_TTL = 600.0
_probes: dict[tuple[str, str, str], tuple[float, list[ToolSnapshot] | None]] = {}


def custom_servers(required_servers, mcp_config: dict) -> dict[str, dict]:
    """The project's CUSTOM_MCP_SERVERS that this type requires, as the SDK starts them."""
    mcp_servers: dict[str, dict] = {}
    for custom in mcp_config.get("CUSTOM_MCP_SERVERS", []):
        server_id = custom.get("id")
        # Only include if agent has it in their effective server list
        if not server_id or server_id not in required_servers:
            continue
        server_type = custom.get("type", "command")
        if server_type == "command":
            mcp_servers[server_id] = {
                "command": custom.get("command", "npx"),
                "args": custom.get("args", []),
            }
            if custom.get("env"):
                mcp_servers[server_id]["env"] = dict(custom["env"])
        elif server_type == "http":
            server_config = {"type": "http", "url": custom.get("url", "")}
            if custom.get("headers"):
                server_config["headers"] = custom["headers"]
            mcp_servers[server_id] = server_config
    return mcp_servers


def _configured(project_dir: Path | str) -> list[dict]:
    from core.mcp_tools import load_mcp_server_configs  # noqa: PLC0415

    return load_mcp_server_configs(str(project_dir))


def pin_verdicts(
    project_dir: Path | str,
    probed: list[tuple[dict, list[ToolSnapshot] | None]],
) -> dict[str, Verdict]:
    """Each probed server's verdict against the project's pins. Never raises.

    A damaged pins file approves nothing.
    """
    names = {str(cfg.get("id")): {t.name for t in tools or []} for cfg, tools in probed}
    out: dict[str, Verdict] = {}
    try:
        configured = _configured(project_dir)
    except (OSError, ValueError):
        configured = []
    for cfg, tools in probed:
        sid = str(cfg.get("id") or cfg.get("name") or "")
        others = set().union(*(n for s, n in names.items() if s != sid))
        try:
            verdict = reconcile(
                project_dir, cfg, tools, configured=configured, other_tools=others
            )
        except (PinError, OSError) as exc:
            verdict = Verdict(sid, "unknown", detail=str(exc))
        if verdict.status != APPROVED or verdict.detail:
            _say(verdict)
        out[sid] = verdict
    return out


def _say(verdict: Verdict) -> None:
    if verdict.status == APPROVED:
        message = f"MCP server '{verdict.server_id}' pinned on first use"
    else:
        held = f" ({', '.join(verdict.held[:5])})" if verdict.held else ""
        message = (
            f"MCP server '{verdict.server_id}' {verdict.status}: {verdict.detail}"
            f"{held}. Review it in Agent Tools → MCP servers."
        )
    print(f"   - {message}")
    logger.warning("[mcp-pins] %s", message)


async def _list(cfg: dict) -> list[ToolSnapshot] | None:
    from core.mcp_tools import MCPToolManager  # noqa: PLC0415

    async with asyncio.timeout(PROBE_TIMEOUT):
        async with MCPToolManager(None, [cfg], pin=False) as manager:
            return manager.listed().get(str(cfg.get("id")))


def _airgapped(project_dir: Path | str) -> bool:
    from offline_policy import airgap_status  # noqa: PLC0415

    return bool(airgap_status(project_dir)["airgapStrict"])


def probe_tools(project_dir: Path | str, cfg: dict) -> list[ToolSnapshot] | None:
    """The tools ``cfg``'s server lists now, or None when it does not answer."""
    if cfg.get("type") == "http" and _airgapped(project_dir):
        return None
    key = (str(pins_root(project_dir)), str(cfg.get("id")), config_digest(cfg))
    cached = _probes.get(key)
    if cached and time.monotonic() - cached[0] < _PROBE_TTL:
        return cached[1]
    # The SDK path builds its client inside a running loop: probe on a thread
    # with a loop of its own.
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        try:
            tools = pool.submit(asyncio.run, _list(cfg)).result(PROBE_TIMEOUT + 5)
        except (TimeoutError, OSError, RuntimeError, ValueError) as exc:
            logger.warning("[mcp-pins] probe of '%s' failed: %s", cfg.get("id"), exc)
            tools = None
    _probes[key] = (time.monotonic(), tools)
    return tools


def pinned_servers(
    project_dir: Path | str, servers: dict[str, dict], mcp_config: dict
) -> dict[str, dict]:
    """The SDK server entries whose every listed tool is approved."""
    if not servers:
        return servers
    configs = [
        c
        for c in mcp_config.get("CUSTOM_MCP_SERVERS", [])
        if isinstance(c, dict) and c.get("id") in servers
    ]
    verdicts = pin_verdicts(
        project_dir, [(cfg, probe_tools(project_dir, cfg)) for cfg in configs]
    )
    return {
        sid: entry
        for sid, entry in servers.items()
        if (v := verdicts.get(sid)) is not None and v.exposed
    }


def _reset_probe_cache() -> None:
    """For the tests."""
    _probes.clear()
