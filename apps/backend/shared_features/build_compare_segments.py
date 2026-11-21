"""What else sets a project's specs apart in "How you compare": the kind of
work each spec was, and the size of the team behind the project.

Both are read from what is already in the project folder, the same on every
stack and every provider:

- a spec's **kind** is the one its card recorded in ``task_metadata.json``
  (``tasks.metadata.record_kind``: chosen by the person, or the verdict of
  ``tasks.classify``), from the closed list of ``TaskKind``; anything else
  is no kind;
- the **team** is the number of distinct commit authors over the last
  ninety days, in buckets; the addresses are counted, never kept.
"""

from __future__ import annotations

from pathlib import Path

from foundation.git_executable import run_git
from tasks.classify import TaskKind

#: The days of history the team is counted over, the commits read at most,
#: and the seconds `git log` may take.
TEAM_DAYS = 90
TEAM_COMMITS = 20_000
GIT_TIMEOUT = 20
#: Upper bounds of the team buckets, in distinct authors.
TEAM_BUCKETS = ((1, "solo"), (5, "small"), (20, "medium"))
#: The kinds a spec may be counted under: the closed list of a card's kinds.
KINDS = tuple(k.value for k in TaskKind)


def spec_kind(metadata: object) -> str | None:
    """The kind a card's metadata records, when it is a known one."""
    if not isinstance(metadata, dict):
        return None
    kind = metadata.get("kind")
    return kind if isinstance(kind, str) and kind in KINDS else None


def team_bucket(project_dir: Path) -> str:
    """The project's team, by its distinct commit authors of the last
    `TEAM_DAYS` days; "unknown" without git or without a recent commit."""
    if not project_dir.is_dir():
        return "unknown"
    result = run_git(
        [
            "log",
            f"--since={TEAM_DAYS}.days",
            f"--max-count={TEAM_COMMITS}",
            "--format=%aE",
        ],
        cwd=project_dir,
        timeout=GIT_TIMEOUT,
    )
    if result.returncode != 0:
        return "unknown"
    authors = len({line.strip().lower() for line in result.stdout.splitlines()} - {""})
    if not authors:
        return "unknown"
    for limit, name in TEAM_BUCKETS:
        if authors <= limit:
            return name
    return "large"
