"""Where the shared brain lives, and what it is made of.

One brain per person, not one per project: the whole point is that Claude Code
in one repository, Codex in another and hermes on a VPS read and write the
*same* knowledge. So the default is a user-level directory, and a project that
wants its own brain says so with ``WORKPILOT_BRAIN_DIR``.

The brain is an Obsidian vault — plain Markdown, YAML frontmatter, ``[[links]]``
— with a Graphify-compatible ``graphify-out/graph.json`` beside it and a git
repository around it. Every part of that is an open format: no agent owns the
brain, and a person can open it in Obsidian, read it in a text editor, or clone
it on another machine without WorkPilot installed.

    <brain>/
      README.md, AGENTS.md         what it is and how to use it — a new brain only
      .workpilot-brain/brain.json  the marker: this folder is a brain (committed)
      .workpilot-brain/INSTRUCTIONS.md  generated digest of the active instructions
      instructions/<slug>.md       one shared instruction per note
      knowledge/<slug>.md          decisions, facts, places — what recall answers
      agents/<agent>/<file>.md     snapshots of each agent's own memory files
      skills/<name>/SKILL.md       skills every connected agent can load
      graphify-out/graph.json      the graph, rebuilt after every write
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

__all__ = [
    "BRAIN_ENV",
    "CONFIG_ENV",
    "KINDS",
    "MARKER",
    "STATE_DIR",
    "is_brain",
    "brain_dir",
    "brain_source",
    "default_brain_dir",
    "config_path",
    "read_config",
    "write_config",
    "kind_dir",
    "graph_path",
    "digest_path",
]

BRAIN_ENV = "WORKPILOT_BRAIN_DIR"
CONFIG_ENV = "WORKPILOT_BRAIN_CONFIG"

STATE_DIR = ".workpilot-brain"
MARKER = f"{STATE_DIR}/brain.json"
"""The file that makes a folder a brain. In a hidden folder, with the generated
digest beside it, so an Obsidian vault a person plugs in shows nothing new in
its file list — a README or a generated note at the root of somebody's vault is
WorkPilot writing into a space that is not its own."""

KINDS: dict[str, str] = {
    "instruction": "instructions",
    "knowledge": "knowledge",
    "agent-memory": "agents",
    "skill": "skills",
}
"""Note kind -> the directory that holds it. A closed set, like hermes's
``SURFACES``: a kind is written into a file a person reads, and a free-text
field fills with whatever string each caller happened to pass."""


def _user_base() -> Path:
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", "").strip()
        return (
            Path(base) if base else Path.home() / "AppData" / "Roaming"
        ) / "WorkPilot"
    return Path.home() / ".workpilot"


def default_brain_dir() -> Path:
    return _user_base() / "brain"


def config_path() -> Path:
    """``brain.json`` beside the default brain: which folder, and whether it is on.

    Per user, not per project, like the brain itself — and a file rather than
    the Electron settings store, because the processes that need the answer are
    Python ones started by the desktop app, by the CLI and by other people's
    agents, and a file is the one thing all of them can read.
    """
    override = os.environ.get(CONFIG_ENV, "").strip()
    return Path(override).expanduser() if override else _user_base() / "brain.json"


def read_config() -> dict[str, Any]:
    try:
        data = json.loads(config_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_config(**fields: Any) -> dict[str, Any]:
    """Merge *fields* into the config; a ``None`` value removes the key."""
    data = read_config()
    for key, value in fields.items():
        if value is None:
            data.pop(key, None)
        else:
            data[key] = value
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return data


def brain_source() -> str:
    """Who decided where the brain is: ``env``, ``config`` or ``default``."""
    if os.environ.get(BRAIN_ENV, "").strip():
        return "env"
    configured = read_config().get("path")
    return "config" if isinstance(configured, str) and configured.strip() else "default"


def brain_dir() -> Path:
    """``WORKPILOT_BRAIN_DIR``, else the folder chosen in Settings, else the default.

    The variable wins because it is how the MCP server WorkPilot registers in
    another agent's configuration says which brain it serves.
    """
    override = os.environ.get(BRAIN_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    configured = read_config().get("path")
    if isinstance(configured, str) and configured.strip():
        return Path(configured).expanduser()
    return default_brain_dir()


def kind_dir(root: Path, kind: str) -> Path:
    if kind not in KINDS:
        raise ValueError(
            f"unknown note kind {kind!r} (expected one of {sorted(KINDS)})"
        )
    return root / KINDS[kind]


def graph_path(root: Path) -> Path:
    """Where Graphify writes, and so where every graph-first reader looks.

    Deliberately not ``GRAPH_JSON``: that variable is how a person points the
    ``graph-first-recall`` skill at *a* graph — often one Graphify built over a
    codebase — and the brain rewrites this file after every write.
    """
    return root / "graphify-out" / "graph.json"


def digest_path(root: Path) -> Path:
    return root / STATE_DIR / "INSTRUCTIONS.md"


def is_brain(root: Path) -> bool:
    """Whether *root* holds a brain: the marker, or the layout of a new one."""
    try:
        return (root / MARKER).is_file() or (
            (root / "README.md").is_file() and (root / KINDS["instruction"]).is_dir()
        )
    except OSError:
        return False
