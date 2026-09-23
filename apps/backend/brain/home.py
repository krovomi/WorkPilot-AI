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
      README.md                    what this directory is, for whoever opens it
      AGENTS.md                    how an agent is expected to use it
      INSTRUCTIONS.md              generated digest of the active instructions
      instructions/<slug>.md       one shared instruction per note
      knowledge/<slug>.md          decisions, facts, places — what recall answers
      agents/<agent>/<file>.md     snapshots of each agent's own memory files
      skills/<name>/SKILL.md       skills every connected agent can load
      graphify-out/graph.json      the graph, rebuilt after every write
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

__all__ = [
    "BRAIN_ENV",
    "KINDS",
    "brain_dir",
    "kind_dir",
    "graph_path",
    "digest_path",
]

BRAIN_ENV = "WORKPILOT_BRAIN_DIR"

KINDS: dict[str, str] = {
    "instruction": "instructions",
    "knowledge": "knowledge",
    "agent-memory": "agents",
    "skill": "skills",
}
"""Note kind -> the directory that holds it. A closed set, like hermes's
``SURFACES``: a kind is written into a file a person reads, and a free-text
field fills with whatever string each caller happened to pass."""


def brain_dir() -> Path:
    """The brain's root: ``WORKPILOT_BRAIN_DIR``, else the per-user default."""
    override = os.environ.get(BRAIN_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    if sys.platform == "win32":
        base = os.environ.get("APPDATA", "").strip()
        return (
            (Path(base) if base else Path.home() / "AppData" / "Roaming")
            / "WorkPilot"
            / "brain"
        )
    return Path.home() / ".workpilot" / "brain"


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
    return root / "INSTRUCTIONS.md"
