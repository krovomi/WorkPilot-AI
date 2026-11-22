"""Confined start of a custom MCP server (issue #369, lot 5).

A ``CUSTOM_MCP_SERVERS`` entry of type ``command`` may carry::

    "confine": {"hosts": ["api.example.com", "*.example.org", "127.0.0.1:5432"]}

The main process writes it on a server whose security score is under the
project policy's ``confineBelow`` (``.workpilot/mcp-policy.json``); the person
may write it on any command server. Whichever provider starts the server
(the Claude Agent SDK, the WorkPilot loop, Codex, OpenCode, an ACP agent, the
pin probe, the MCP App view session), it is started under the OS sandbox of
`os_sandbox` with a policy of its own:

* **network**: the filtering proxy, allowing only the listed hosts and the
  registry its launcher installs from (``npx``, ``npm``: npm; ``uvx``,
  ``uv``: PyPI; ``node``, ``python``: none). ``WORKPILOT_SANDBOX_HOSTS`` is
  not added: the entry says what this server may reach;
* **files**: the build's, as for any sandboxed command: writes in the project
  (the worktree), ``<tmp>/workpilot`` and the package caches, credentials
  hidden.

A confined server is never started any other way. Without a sandbox on this
machine (Windows, no bubblewrap, ``WORKPILOT_SANDBOX=off``), or without a
project to build the policy from, it is not started, and the log says why.
`machine_confinement` says the same to the app (``runners/mcp_sandbox_runner.py``),
which names the reason next to each confined server: never a silent start
without the sandbox, and no switch to start one so.
Nothing here widens what `core.custom_mcp_validation` accepts: the launcher
is still checked there, and only WorkPilot builds the command that wraps it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = [
    "CONFINED_MARK",
    "CONFINE_FIELD",
    "MAX_CONFINE_HOSTS",
    "confine_hosts",
    "confined_launch",
    "confined_server",
    "machine_confinement",
    "valid_confine",
]

CONFINE_FIELD = "confine"
#: Set by `confined_server` on an entry whose launcher is the sandbox, for a
#: CLI config that must quote it its own way (Codex).
CONFINED_MARK = "confined"
MAX_CONFINE_HOSTS = 32
#: The program that sets the proxy variables before the sandbox starts: the
#: server's own environment (its API key) is never put on a command line.
_ENV_PROGRAM = "/usr/bin/env"

#: The registry each launcher fetches its package from.
_LAUNCHER_REGISTRIES: dict[str, tuple[str, ...]] = {
    "npx": ("registry.npmjs.org",),
    "npm": ("registry.npmjs.org",),
    "uvx": ("pypi.org", "files.pythonhosted.org"),
    "uv": ("pypi.org", "files.pythonhosted.org"),
}


def valid_confine(server: Mapping[str, Any]) -> bool:
    """Whether the ``confine`` field of ``server``, if any, is well formed.

    A map with exactly one key, ``hosts``: a list of at most
    `MAX_CONFINE_HOSTS` entries, each one the sandbox allowlist accepts
    (`os_sandbox.hosts.parse_rule`). Only a command server runs here; an
    HTTP server cannot be confined.
    """
    if CONFINE_FIELD not in server:
        return True
    if server.get("type") != "command":
        logger.warning("Only a command-type MCP server can be confined")
        return False
    value = server[CONFINE_FIELD]
    if not isinstance(value, Mapping) or set(value) != {"hosts"}:
        logger.warning("MCP server 'confine' must be {\"hosts\": [...]}")
        return False
    hosts = value["hosts"]
    if not isinstance(hosts, list) or len(hosts) > MAX_CONFINE_HOSTS:
        logger.warning(
            "MCP server 'confine.hosts' must be a list of at most %d hosts",
            MAX_CONFINE_HOSTS,
        )
        return False
    from os_sandbox.hosts import parse_rule  # noqa: PLC0415

    for host in hosts:
        if not isinstance(host, str) or len(host) > 260 or parse_rule(host) is None:
            logger.warning("Rejected host %r in MCP server 'confine.hosts'", host)
            return False
    return True


def confine_hosts(server: Mapping[str, Any]) -> list[str] | None:
    """The hosts a confined server may reach, or None when it is not confined."""
    value = server.get(CONFINE_FIELD)
    if not isinstance(value, Mapping):
        return None
    hosts = value.get("hosts")
    return [str(h) for h in hosts] if isinstance(hosts, list) else []


@dataclass(frozen=True)
class MachineConfinement:
    """Whether a confined server can start on this machine, and if not, why.

    ``kind``: ``available``, ``off`` (``WORKPILOT_SANDBOX=off``), or the
    sandbox's own (``unsupported``, ``missing``, ``refused``). ``reason`` is
    stable English, for the log and as the detail under the app's sentence.
    """

    available: bool
    kind: str
    backend: str | None
    reason: str | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "kind": self.kind,
            "backend": self.backend,
            "reason": self.reason,
        }


def machine_confinement() -> MachineConfinement:
    """Whether this machine starts a confined server (the probe is cached)."""
    import os_sandbox  # noqa: PLC0415
    from os_sandbox.launch import UNSUPPORTED, probe  # noqa: PLC0415

    if os_sandbox.sandbox_mode() == os_sandbox.OFF:
        return MachineConfinement(
            False, "off", None, f"the OS sandbox is off ({os_sandbox.MODE_ENV}=off)"
        )
    status = probe()
    if status.available:
        return MachineConfinement(True, "available", status.backend, None)
    return MachineConfinement(
        False,
        status.kind or UNSUPPORTED,
        status.backend,
        status.reason or "this machine has no OS sandbox",
    )


def _refuse(server: Mapping[str, Any], why: str) -> None:
    logger.warning(
        "[mcp-confine] MCP server '%s' not started: it must run confined, and %s",
        server.get("id"),
        why,
    )


def confined_launch(
    server: Mapping[str, Any],
    command: str,
    args: list[str],
    project_dir: str | Path | None,
) -> tuple[str, list[str]] | None:
    """``command`` and ``args`` of a confined ``server``, as started, or None.

    The launch is ``/usr/bin/env <proxy variables> <sandbox> … <command>
    <args>``. None means the server must not start (and the log says why).
    """
    hosts = confine_hosts(server)
    if hosts is None:
        return command, list(args)
    if not project_dir:
        _refuse(server, "there is no project to confine it to")
        return None
    from os_sandbox.hosts import HostAllowlist  # noqa: PLC0415
    from os_sandbox.launch import sandboxed  # noqa: PLC0415
    from os_sandbox.policy import build_policy  # noqa: PLC0415

    machine = machine_confinement()
    if not machine.available:
        _refuse(server, machine.reason or "this machine has no OS sandbox")
        return None
    allowlist = HostAllowlist.build(hosts, _LAUNCHER_REGISTRIES.get(command, ()))
    try:
        policy = build_policy(project_dir, None, allowlist=allowlist)
        wrapped = sandboxed([command, *args], policy, {})
    except (OSError, RuntimeError, ValueError) as exc:
        _refuse(server, f"the sandbox could not be prepared: {exc}")
        return None
    variables = [f"{name}={value}" for name, value in sorted(wrapped.env.items())]
    logger.info(
        "[mcp-confine] MCP server '%s' runs in the OS sandbox (%s), network: %s",
        server.get("id"),
        wrapped.backend,
        ", ".join(allowlist.describe()) or "none",
    )
    return _ENV_PROGRAM, [*variables, *wrapped.argv]


def confined_server(
    server: Mapping[str, Any], project_dir: str | Path | None
) -> dict[str, Any] | None:
    """``server`` as a CLI starts it: wrapped when confined, None when it may not start.

    An unconfined server comes back as a copy. A confined one loses its
    ``confine`` field and carries `CONFINED_MARK` instead.
    """
    out = dict(server)
    if confine_hosts(server) is None:
        return out
    launch = confined_launch(
        server,
        str(server.get("command") or "npx"),
        [str(a) for a in server.get("args") or []],
        project_dir,
    )
    if launch is None:
        return None
    out.pop(CONFINE_FIELD, None)
    out["command"], out["args"] = launch
    out[CONFINED_MARK] = True
    return out
