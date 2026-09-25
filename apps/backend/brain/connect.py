"""Plug an agent into the brain: register the ``workpilot-brain`` MCP server.

MCP is the one interface every agent here speaks, so it is the one door into the
brain — Claude Code, Codex, hermes, Gemini, Cursor, Windsurf and OpenClaw each
declare servers in their own file and their own format, and this module knows
all of them (the table is `agents.AGENTS`).

**Printed by default, written on request.** A person's agent configuration is
theirs; ``connect`` returns the snippet, and ``apply=True`` — an explicit
gesture, like the hermes persona install — writes it, after a one-time backup
beside the original. A file that does not parse is never rewritten: the snippet
is returned with the reason instead.

The TOML and YAML entries are written as delimited blocks rather than through a
parser round-trip, because both files are hand-edited and a round-trip drops
every comment in them.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .agents import AGENTS, AgentSpec, agent

__all__ = ["SERVER_NAME", "server_entry", "snippet", "connect", "connect_all"]

SERVER_NAME = "workpilot-brain"
_START = f"# {SERVER_NAME}:start (géré par WorkPilot)"
_END = f"# {SERVER_NAME}:end"

_BACKEND = Path(__file__).resolve().parent.parent


def server_entry(root: Path) -> dict[str, Any]:
    """``command`` / ``args`` / ``env`` — the shape every MCP client shares."""
    return {
        "command": sys.executable,
        "args": [str(_BACKEND / "runners" / "brain_mcp.py")],
        "env": {"WORKPILOT_BRAIN_DIR": str(root)},
    }


def _toml_str(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def snippet(spec: AgentSpec, root: Path) -> str:
    entry = server_entry(root)
    if spec.mcp_format == "toml":
        args = ", ".join(_toml_str(a) for a in entry["args"])
        env = ", ".join(f"{k} = {_toml_str(v)}" for k, v in entry["env"].items())
        return "\n".join(
            [
                _START,
                f"[mcp_servers.{SERVER_NAME}]",
                f"command = {_toml_str(entry['command'])}",
                f"args = [{args}]",
                f"env = {{ {env} }}",
                _END,
            ]
        )
    if spec.mcp_format == "yaml":
        lines = [
            _START,
            "mcp_servers:",
            f"  {SERVER_NAME}:",
            f"    command: {_toml_str(entry['command'])}",
            "    args:",
            *[f"      - {_toml_str(a)}" for a in entry["args"]],
            "    env:",
            *[f"      {k}: {_toml_str(v)}" for k, v in entry["env"].items()],
            _END,
        ]
        return "\n".join(lines)
    key = "servers" if spec.name == "copilot" else "mcpServers"
    return json.dumps({key: {SERVER_NAME: entry}}, indent=2, ensure_ascii=False)


@dataclass
class ConnectResult:
    agent: str
    path: str | None
    action: str
    """``written``, ``unchanged``, ``preview``, ``manual`` or ``error``."""
    snippet: str
    backup: str | None = None
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _backup(path: Path) -> str | None:
    if not path.is_file():
        return None
    backup = path.with_name(path.name + ".workpilot-brain.bak")
    if not backup.exists():
        shutil.copyfile(path, backup)
    return str(backup)


def _replace_block(text: str, block: str) -> str:
    if _START in text and _END in text:
        head, rest = text.split(_START, 1)
        _, tail = rest.split(_END, 1)
        return head + block + tail
    sep = (
        ""
        if not text or text.endswith("\n\n")
        else ("\n" if text.endswith("\n") else "\n\n")
    )
    return text + sep + block + "\n"


def _connect_json(
    spec: AgentSpec, path: Path, root: Path, apply: bool, text: str
) -> ConnectResult:
    try:
        data = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    except ValueError as exc:
        return ConnectResult(
            spec.name,
            str(path),
            "error",
            text,
            reason=f"{path.name} is not valid JSON: {exc}",
        )
    if not isinstance(data, dict):
        return ConnectResult(
            spec.name,
            str(path),
            "error",
            text,
            reason=f"{path.name} is not a JSON object",
        )
    servers = data.setdefault(spec.mcp_key[0], {})
    if not isinstance(servers, dict):
        return ConnectResult(
            spec.name,
            str(path),
            "error",
            text,
            reason=f"{spec.mcp_key[0]} is not a map",
        )
    entry = server_entry(root)
    if servers.get(SERVER_NAME) == entry:
        return ConnectResult(spec.name, str(path), "unchanged", text)
    if not apply:
        return ConnectResult(spec.name, str(path), "preview", text)
    backup = _backup(path)
    servers[SERVER_NAME] = entry
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return ConnectResult(spec.name, str(path), "written", text, backup=backup)


def _connect_claude_cli(spec: AgentSpec, root: Path, text: str) -> ConnectResult | None:
    """Claude Code owns ``~/.claude.json`` and rewrites it while running; its CLI
    is the safe writer when it is installed."""
    exe = shutil.which("claude")
    if not exe:
        return None
    entry = {"type": "stdio", **server_entry(root)}
    subprocess.run(
        [exe, "mcp", "remove", "--scope", "user", SERVER_NAME],
        capture_output=True,
        timeout=30,
    )
    done = subprocess.run(
        [exe, "mcp", "add-json", "--scope", "user", SERVER_NAME, json.dumps(entry)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    if done.returncode != 0:
        return None
    return ConnectResult(spec.name, "claude mcp add-json --scope user", "written", text)


def connect(root: Path, name: str, *, apply: bool = False) -> ConnectResult:
    spec = agent(name)
    text = snippet(spec, root)
    path = spec.mcp_path()
    if spec.mcp_format == "manual" or path is None:
        return ConnectResult(
            spec.name,
            str(path) if path else None,
            "manual",
            text,
            reason=spec.notes or None,
        )
    if spec.mcp_format == "json":
        if apply and spec.name == "claude-code":
            via_cli = _connect_claude_cli(spec, root, text)
            if via_cli is not None:
                return via_cli
        return _connect_json(spec, path, root, apply, text)

    current = (
        path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
    )
    if (
        spec.mcp_format == "yaml"
        and _START not in current
        and any(line.startswith("mcp_servers:") for line in current.splitlines())
    ):
        # A second top-level key would shadow the user's own servers.
        return ConnectResult(
            spec.name,
            str(path),
            "manual",
            text,
            reason="mcp_servers already declared: add the workpilot-brain entry under it",
        )
    if (
        spec.mcp_format == "toml"
        and f"[mcp_servers.{SERVER_NAME}]" in current
        and _START not in current
    ):
        return ConnectResult(
            spec.name,
            str(path),
            "manual",
            text,
            reason="an unmanaged entry already exists",
        )
    updated = _replace_block(current, text)
    if updated == current:
        return ConnectResult(spec.name, str(path), "unchanged", text)
    if not apply:
        return ConnectResult(spec.name, str(path), "preview", text)
    backup = _backup(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(updated, encoding="utf-8")
    return ConnectResult(spec.name, str(path), "written", text, backup=backup)


def connect_all(
    root: Path, *, apply: bool = False, names: list[str] | None = None
) -> list[ConnectResult]:
    """Every agent, or the ones named. Unnamed agents that are not installed —
    their configuration directory does not exist — are reported, not created."""
    out = []
    for spec in AGENTS:
        if names and spec.name not in names:
            continue
        path = spec.mcp_path()
        if apply and not names and path is not None and not path.parent.exists():
            out.append(
                ConnectResult(
                    spec.name,
                    str(path),
                    "absent",
                    snippet(spec, root),
                    reason="not installed",
                )
            )
            continue
        out.append(connect(root, spec.name, apply=apply))
    return out
