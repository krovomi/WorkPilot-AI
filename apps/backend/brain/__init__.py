"""WorkPilot Brain — one knowledge base, every agent, none of them owns it.

An Obsidian vault with a Graphify-format ``graph.json`` beside it, kept in a git
repository that is pulled before reads and pushed after writes, and served to
any agent over MCP (``workpilot-brain``).

| Module | Answers |
|---|---|
| `home.py` | where the brain is, and what its directories hold |
| `notes.py` | one note: frontmatter, ``[[links]]``, ``#tags``, atomic write |
| `graph.py` | the Graphify ``graph.json``, built from the notes, and its queries |
| `sync.py` | commit / pull / push, conflicts kept on both sides |
| `agents.py` | where each agent keeps its memory and its MCP configuration |
| `memories.py` | agent memories -> brain (ingest), brain -> agent memories (bridge) |
| `connect.py` | registering the MCP server in each agent |
| `vault.py` | `Brain`: the one object every surface calls |
| `mcp_server.py` | the stdio MCP server |
| `runtime.py` | how every WorkPilot feature reaches it: MCP server, prompt section, tool executor |
| `learn.py` | what WorkPilot records itself: every build, every merge, other surfaces |
| `api.py` | ``/api/brain/*``: settings (vault folder, git remote), a task's learning, proposals |
"""

from __future__ import annotations

from .home import brain_dir
from .vault import Brain

__all__ = ["Brain", "brain_dir"]
