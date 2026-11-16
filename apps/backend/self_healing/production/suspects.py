"""The commits most likely to have caused a production error (#372).

Ranked from git alone: the commits since the last release (the most recent
tag reachable from ``HEAD``; without a tag, the last :data:`MAX_COMMITS`) that
touched the files of the trace's frames. A commit that touched the innermost
frame's file weighs more than one that touched a caller's; among equals the
newer commit comes first.

git is run with an argument list, no shell, a timeout, and the files after
``--`` so that none of them can read as an option. A commit subject is text
of the repository: whoever shows it to a model quotes it as data.
"""

from __future__ import annotations

import logging
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

__all__ = ["MAX_COMMITS", "last_release", "rank_suspect_commits"]

MAX_COMMITS = 200
MAX_SUSPECTS = 5
_TIMEOUT = 30
_RECORD = "\x1e"
_FIELD = "\x1f"


def _git(project_dir: Path, args: Sequence[str]) -> str | None:
    try:
        result = subprocess.run(  # noqa: S603 - argv list, no shell
            ["git", *args],
            cwd=str(project_dir),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_TIMEOUT,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.debug("git %s failed: %s", args[:1], exc)
        return None
    return result.stdout if result.returncode == 0 else None


def last_release(project_dir: Path) -> str:
    """The most recent tag reachable from HEAD, "" when there is none."""
    out = _git(project_dir, ["describe", "--tags", "--abbrev=0", "HEAD"])
    return (out or "").strip()


def _safe_files(files: Sequence[str]) -> list[str]:
    kept: list[str] = []
    for name in files:
        name = str(name).replace("\\", "/").strip()
        if not name or name.startswith(("/", "-")) or ".." in name.split("/"):
            continue
        if name not in kept:
            kept.append(name)
    return kept


def rank_suspect_commits(
    project_dir: str | Path,
    frame_files: Sequence[str],
    *,
    since: str | None = None,
    limit: int = MAX_SUSPECTS,
) -> list[dict[str, Any]]:
    """The commits that touched ``frame_files`` (innermost first), most suspect first."""
    root = Path(project_dir)
    files = _safe_files(frame_files)
    if not files:
        return []
    release = last_release(root) if since is None else since
    range_args = [f"{release}..HEAD"] if release else ["HEAD"]
    out = _git(
        root,
        [
            "log",
            f"--max-count={MAX_COMMITS}",
            f"--format={_RECORD}%H{_FIELD}%ct{_FIELD}%s",
            "--name-only",
            *range_args,
            "--",
            *files,
        ],
    )
    if not out:
        return []
    weight = {name: 1.0 / (rank + 1) for rank, name in enumerate(files)}
    suspects: list[dict[str, Any]] = []
    for record in out.split(_RECORD):
        lines = [line for line in record.splitlines() if line.strip()]
        if not lines:
            continue
        head = lines[0].split(_FIELD)
        if len(head) < 3:
            continue
        sha, committed, subject = head[0], head[1], head[2]
        touched = [name for name in lines[1:] if name in weight]
        if not touched:
            continue
        try:
            when = int(committed)
        except ValueError:
            when = 0
        suspects.append(
            {
                "sha": sha,
                "subject": subject[:200],
                "committed_at": when,
                "files": touched,
                "score": round(sum(weight[name] for name in touched), 3),
            }
        )
    suspects.sort(key=lambda s: (s["score"], s["committed_at"]), reverse=True)
    for suspect in suspects:
        suspect["since"] = release
    return suspects[:limit]
