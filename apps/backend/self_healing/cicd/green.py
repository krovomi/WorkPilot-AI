"""The last commit seen green, per branch (#375).

A bisect needs a commit where the tests passed. The CI/CD runner records one
each time it runs the suite and it passes; a CI hook may also name one
(``cicd --good``). Kept in ``.workpilot/self-healing/last_green.json``.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from foundation.file_utils import write_json_atomic

from .triggers import git, is_commit_sha

logger = logging.getLogger(__name__)

__all__ = ["GREEN_FILE", "head_sha", "last_green", "record_green"]

GREEN_FILE = Path(".workpilot") / "self-healing" / "last_green.json"
_MAX_BRANCHES = 50


def _read(project_dir: Path) -> dict[str, dict[str, str]]:
    path = project_dir / GREEN_FILE
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def head_sha(project_dir: str | Path) -> str:
    out = (git(Path(project_dir), ["rev-parse", "HEAD"]) or "").strip()
    return out if is_commit_sha(out) else ""


def record_green(project_dir: str | Path, branch: str, sha: str) -> bool:
    if not is_commit_sha(sha) or not branch:
        return False
    root = Path(project_dir)
    data = _read(root)
    # The file keeps branches in the order they were last recorded, so the
    # oldest is evicted first without trusting the clock (two records can
    # share a timestamp on a coarse clock).
    key = str(branch)[:200]
    data.pop(key, None)
    data[key] = {"sha": sha, "at": datetime.now(UTC).isoformat()}
    while len(data) > _MAX_BRANCHES:
        del data[next(iter(data))]
    try:
        (root / GREEN_FILE).parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(root / GREEN_FILE, data)
    except OSError as exc:
        logger.warning("last green commit not recorded: %s", exc)
        return False
    return True


def last_green(project_dir: str | Path, branch: str) -> str:
    entry = _read(Path(project_dir)).get(str(branch), {})
    sha = entry.get("sha", "") if isinstance(entry, dict) else ""
    return sha if is_commit_sha(sha) else ""
