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

A segment can change: a repository grows from small to medium, a team from
two to six. For one window after the change the project is set against
both its old and its new peers (``moved``), so its comparison does not jump.
What it was one window ago is read from git as well, never recorded: the
files of the last commit before then (``tracked_files_at``) and the authors
of the ninety days before then (``team_bucket(days_ago=…)``).
"""

from __future__ import annotations

from datetime import datetime
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


def team_bucket(project_dir: Path, *, days_ago: int = 0) -> str:
    """The project's team, by its distinct commit authors of the `TEAM_DAYS`
    days up to `days_ago` days ago; "unknown" without git or without a
    commit in that span."""
    if not project_dir.is_dir():
        return "unknown"
    span = [f"--since={TEAM_DAYS + days_ago}.days"]
    if days_ago:
        span.append(f"--until={days_ago}.days")
    result = run_git(
        ["log", *span, f"--max-count={TEAM_COMMITS}", "--format=%aE"],
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


def tracked_files_at(project_dir: Path, moment: datetime) -> int | None:
    """The files of the last commit before `moment`; None without git or
    without a commit that old."""
    if not project_dir.is_dir():
        return None
    found = run_git(
        ["rev-list", "-1", f"--before={moment.isoformat()}", "HEAD"],
        cwd=project_dir,
        timeout=GIT_TIMEOUT,
    )
    commit = found.stdout.strip() if found.returncode == 0 else ""
    if not commit:
        return None
    listed = run_git(
        ["ls-tree", "-r", "-z", "--name-only", commit],
        cwd=project_dir,
        timeout=GIT_TIMEOUT,
    )
    return listed.stdout.count("\0") if listed.returncode == 0 else None


def moved(now: str, before: str | None) -> tuple[set[str], str | None]:
    """The buckets a project is compared in, and the one it left: both its
    new and its old bucket while it moves, its own otherwise. Coming from
    or going to "unknown" is no move: a young repository has no past."""
    if before is None or "unknown" in (now, before) or before == now:
        return {now}, None
    return {now, before}, before
