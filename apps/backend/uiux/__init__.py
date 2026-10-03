"""ui-ux-pro-max (Basic edition) in the build pipeline — contextual, provider-agnostic.

The vendored skill (`skills/ui-ux-pro-max/`) is a design-data engine: styles,
palettes, font pairings, UX guidelines and the rules of 22 UI stacks, searched
by a standard-library BM25 with no network and no model. This package decides
*when* a build uses it and hands the answer to every provider the same way.

| Module | Answers |
|---|---|
| `surface` | is this file part of an interface? (the one glob list) |
| `stack` | which UI toolkits the project uses, and which upstream guide fits |
| `relevance` | does this task touch the interface? override → plan → description |
| `runtime` | where the vendored skill is, and the doctor |
| `engine` | runs `search.py` with the backend's own interpreter, arguments checked |
| `preflight` | the project's `MASTER.md`, else a generated one written to the worktree |
| `prompt` | the section the coder, QA and skill phases read — empty off the UI |
| `mcp_server` | `workpilot-uiux`: the same engine as read-only MCP tools |
| `integration` | the server and tools, offered only to a UI task's agents |
| `api` | `GET /api/uiux/task`, `POST /api/uiux/override` |
"""

from __future__ import annotations

from .prompt import uiux_section
from .relevance import Relevance, assess
from .surface import UI_GLOBS, is_ui_path

__all__ = ["UI_GLOBS", "Relevance", "assess", "is_ui_path", "uiux_section"]
