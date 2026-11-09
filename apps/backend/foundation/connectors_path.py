"""Make ``import src.connectors`` work wherever the backend runs.

The shared connectors (LLM provider config, Jira, Azure DevOps…) live in the
``src`` package. It sits in one of two places:

- the installed app ships it inside the backend (``resources/backend/src``,
  ``extraResources`` in apps/frontend/package.json); the backend directory is
  on every runner's path, so nothing is needed;
- the repository (``pnpm run dev``) and the server image keep it at the root,
  two levels above the backend; that directory used to be on the path only
  for ``run.py`` and the CLI, so every runner started by the app in dev mode,
  and every server process, failed with ``No module named 'src'`` as soon as
  it touched a connector (Mistral, DeepSeek and Grok one-shot calls first).

``ensure_connectors_on_path()`` appends the directory holding ``src`` to
``sys.path`` when it is not reachable yet. Appended, not prepended: a module
of the backend or of the environment always wins over the repository root.
"""

from __future__ import annotations

import sys
from pathlib import Path

__all__ = ["connectors_root", "ensure_connectors_on_path"]

_BACKEND_DIR = Path(__file__).resolve().parent.parent


def _has_connectors(root: Path) -> bool:
    return (root / "src" / "connectors" / "__init__.py").is_file()


def connectors_root(backend_dir: Path = _BACKEND_DIR) -> Path | None:
    """The directory whose ``src/connectors`` the backend imports, if any."""
    for root in (backend_dir, backend_dir.parent.parent):
        if _has_connectors(root):
            return root
    return None


def _on_path(root: Path) -> bool:
    for entry in sys.path:
        try:
            if Path(entry or ".").resolve() == root:
                return True
        except OSError:
            continue
    return False


def ensure_connectors_on_path(backend_dir: Path = _BACKEND_DIR) -> Path | None:
    """Put the connectors' root on ``sys.path`` if needed; return it."""
    root = connectors_root(backend_dir)
    if root is not None and not _on_path(root):
        sys.path.append(str(root))
    return root
