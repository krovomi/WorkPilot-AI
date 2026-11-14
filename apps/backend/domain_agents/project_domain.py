"""The business domain a project's agents work in.

A spec may name its own (``requirements.json`` → ``domain``); otherwise the
project's choice applies, saved from the Domain Agents tab to
``.workpilot/domain.json`` of the project (not of a task's worktree, whose
``.workpilot/`` is its own and is not committed).

A task runs in ``<project>/.workpilot/worktrees/tasks/<spec>/`` with its spec
copied to ``…/<spec>/.workpilot/specs/<spec>/``: `project_root_of` walks back
from either spec folder to the project the user picked.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from .factory import DomainTag

logger = logging.getLogger(__name__)

DOMAIN_FILE = Path(".workpilot") / "domain.json"


def project_root_of(spec_dir: Path) -> Path | None:
    """The project a spec belongs to, from the main checkout or a task worktree."""
    parts = Path(spec_dir).resolve().parts
    specs = [
        i
        for i in range(1, len(parts) - 1)
        if parts[i] == ".workpilot" and parts[i + 1] == "specs"
    ]
    if not specs:
        return None
    root = parts[: specs[-1]]
    # <project>/.workpilot/worktrees/tasks/<spec> → <project>
    if len(root) > 4 and root[-4] == ".workpilot" and root[-3] == "worktrees":
        root = root[:-4]
    return Path(*root)


def read_project_domain(project_dir: Path) -> str | None:
    """The domain saved for ``project_dir``, or None (absent, unreadable, unknown)."""
    path = Path(project_dir) / DOMAIN_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        logger.debug("unreadable %s: %s", path, exc)
        return None
    domain = data.get("domain") if isinstance(data, dict) else None
    if not isinstance(domain, str):
        return None
    try:
        return DomainTag(domain.strip()).value
    except ValueError:
        return None


def write_project_domain(project_dir: Path, domain: str | None) -> str | None:
    """Save ``domain`` for ``project_dir``; None or ``generic`` removes the choice.

    Raises ValueError for a domain the catalogue does not know.
    """
    path = Path(project_dir) / DOMAIN_FILE
    tag = DomainTag(domain).value if domain else None
    if tag is None or tag == DomainTag.GENERIC.value:
        path.unlink(missing_ok=True)
        return None
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"domain": tag}, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)
    return tag
