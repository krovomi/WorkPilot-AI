"""Every agent the brain knows how to reach: where it keeps its memory, and how
it is told about an MCP server.

One table, read by the memory bridge (`memories.py`) and by the MCP connector
(`connect.py`). Two tables would be two answers to "where does Codex keep its
instructions?", and they would drift the first time a harness moved a file.

The paths are each tool's own documented defaults. Nothing here guesses: an
agent whose file does not exist is reported as absent, not created — except by
an explicit ``bridge`` or ``connect``, which a person asks for.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

__all__ = ["AgentSpec", "AGENTS", "agent", "home"]


def home() -> Path:
    return Path(os.environ.get("WORKPILOT_BRAIN_HOME", "") or Path.home()).expanduser()


def _hermes_home() -> Path:
    override = os.environ.get("HERMES_HOME", "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA", "").strip()
        return (Path(local) if local else home() / "AppData" / "Local") / "hermes"
    return home() / ".hermes"


@dataclass(frozen=True)
class AgentSpec:
    name: str
    label: str
    global_memory: tuple[str, ...] = ()
    """Memory/instruction files in the user's home, relative to it (``~``)."""
    project_memory: tuple[str, ...] = ()
    """Memory/instruction files inside a project checkout."""
    bridge_file: str | None = None
    """The global file the bridge block is written into (one of ``global_memory``)."""
    supports_import: bool = False
    """Whether the file can pull another one in (Claude Code's ``@path``)."""
    bridge_budget: int = 6000
    """Characters the bridge may add. Hermes caps its memory file hard."""
    mcp_format: str = "json"
    """``json`` (an ``mcpServers`` map), ``toml`` (Codex), ``yaml`` (hermes) or ``manual``."""
    mcp_config: str | None = None
    mcp_key: tuple[str, ...] = ("mcpServers",)
    notes: str = ""

    def resolve(self, rel: str) -> Path:
        if rel.startswith("$HERMES_HOME/"):
            return _hermes_home() / rel.removeprefix("$HERMES_HOME/")
        return home() / rel

    def global_paths(self) -> list[Path]:
        return [self.resolve(rel) for rel in self.global_memory]

    def bridge_path(self) -> Path | None:
        return self.resolve(self.bridge_file) if self.bridge_file else None

    def mcp_path(self) -> Path | None:
        return self.resolve(self.mcp_config) if self.mcp_config else None


AGENTS: tuple[AgentSpec, ...] = (
    AgentSpec(
        name="claude-code",
        label="Claude Code",
        global_memory=(".claude/CLAUDE.md",),
        project_memory=("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"),
        bridge_file=".claude/CLAUDE.md",
        supports_import=True,
        mcp_config=".claude.json",
    ),
    AgentSpec(
        name="codex",
        label="Codex",
        global_memory=(".codex/AGENTS.md",),
        project_memory=("AGENTS.md",),
        bridge_file=".codex/AGENTS.md",
        mcp_format="toml",
        mcp_config=".codex/config.toml",
        mcp_key=("mcp_servers",),
    ),
    AgentSpec(
        name="hermes",
        label="Hermes",
        global_memory=(
            "$HERMES_HOME/memories/MEMORY.md",
            "$HERMES_HOME/memories/USER.md",
        ),
        project_memory=(".hermes.md", "HERMES.md"),
        bridge_file="$HERMES_HOME/memories/MEMORY.md",
        bridge_budget=900,
        mcp_format="yaml",
        mcp_config="$HERMES_HOME/config.yaml",
        mcp_key=("mcp_servers",),
        notes="hermes caps MEMORY.md; the bridge there is a pointer, the content comes through MCP",
    ),
    AgentSpec(
        name="openclaw",
        label="OpenClaw",
        global_memory=(
            ".openclaw/workspace/MEMORY.md",
            ".openclaw/workspace/AGENTS.md",
        ),
        bridge_file=".openclaw/workspace/AGENTS.md",
        mcp_format="manual",
        mcp_config=".openclaw/openclaw.json",
        notes="the MCP key of openclaw.json moves between releases; the snippet is printed, not written",
    ),
    AgentSpec(
        name="gemini",
        label="Gemini CLI",
        global_memory=(".gemini/GEMINI.md",),
        project_memory=("GEMINI.md",),
        bridge_file=".gemini/GEMINI.md",
        supports_import=True,
        mcp_config=".gemini/settings.json",
    ),
    AgentSpec(
        name="cursor",
        label="Cursor",
        project_memory=(".cursorrules",),
        mcp_config=".cursor/mcp.json",
    ),
    AgentSpec(
        name="windsurf",
        label="Windsurf",
        global_memory=(".codeium/windsurf/memories/global_rules.md",),
        project_memory=(".windsurfrules",),
        bridge_file=".codeium/windsurf/memories/global_rules.md",
        mcp_config=".codeium/windsurf/mcp_config.json",
    ),
    AgentSpec(
        name="copilot",
        label="GitHub Copilot",
        project_memory=(".github/copilot-instructions.md",),
        mcp_format="manual",
        notes="Copilot reads MCP servers from the IDE (VS Code: .vscode/mcp.json, key `servers`)",
    ),
)


def agent(name: str) -> AgentSpec:
    for spec in AGENTS:
        if spec.name == name:
            return spec
    raise KeyError(
        f"unknown agent {name!r} (known: {', '.join(a.name for a in AGENTS)})"
    )
