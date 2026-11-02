"""Branches, tags and commits of a clone, as the desktop reads a checkout's.

The same git commands as ``main/changelog/git-integration.ts``, run through
``foundation.git_executable.run_git`` (an argument list, no shell, an
isolated git environment, a timeout). The references come from
``options.GitHistory`` and ``options.BranchDiff``, whose patterns keep any of
them from being read as an option; ``--end-of-options`` says so to git too.
What git prints is bounded: at most ``MAX_COMMITS`` commits, ``MAX_REFS``
branches and tags.
"""

from __future__ import annotations

from pathlib import Path

from changelog_generator.options import MAX_COMMITS, BranchDiff, GitHistory
from changelog_generator.prompts import Commit, last_version
from foundation.git_executable import run_git

MAX_REFS = 500
#: The existing ``CHANGELOG.md`` read for its last version, at most.
MAX_EXISTING = 200_000
_LOG_FORMAT = "--pretty=format:%h|%H|%s|%an|%ae|%aI"


def _git(clone: Path, args: list[str]) -> str:
    result = run_git(args, cwd=clone, timeout=30)
    return result.stdout if result.returncode == 0 else ""


def current_branch(clone: Path) -> str:
    return _git(clone, ["rev-parse", "--abbrev-ref", "HEAD"]).strip()


def default_branch(clone: Path) -> str:
    head = _git(clone, ["rev-parse", "--abbrev-ref", "origin/HEAD"]).strip()
    if head:
        return head.removeprefix("origin/")
    for name in ("main", "master"):
        if _git(clone, ["rev-parse", "--verify", "--quiet", name]).strip():
            return name
    return "main"


def branches(clone: Path) -> list[dict[str, object]]:
    """Local and remote branches, the current first, then local, then remote."""
    current = current_branch(clone)
    output = _git(clone, ["branch", "-a", "--format=%(refname:short)|%(HEAD)"])
    found: list[dict[str, object]] = []
    seen: set[str] = set()
    for line in output.splitlines():
        name, _, head = line.strip().partition("|")
        if not name or "HEAD" in name:
            continue
        remote = name.startswith("origin/") or "/" in name
        shown = name.removeprefix("origin/") if remote else name
        if shown in seen and remote:
            continue
        seen.add(shown)
        found.append(
            {
                "name": shown,
                "isRemote": remote,
                "isCurrent": head == "*" or shown == current,
            }
        )
        if len(found) >= MAX_REFS:
            break
    found.sort(key=lambda b: (not b["isCurrent"], bool(b["isRemote"]), str(b["name"])))
    return found


def tags(clone: Path) -> list[dict[str, str | None]]:
    """Tags, newest first."""
    output = _git(
        clone,
        [
            "tag",
            "-l",
            "--sort=-creatordate",
            "--format=%(refname:short)|%(creatordate:iso-strict)|%(objectname:short)",
        ],
    )
    found: list[dict[str, str | None]] = []
    for line in output.splitlines():
        parts = line.strip().split("|")
        if not parts[0]:
            continue
        found.append(
            {
                "name": parts[0],
                "date": (parts[1] if len(parts) > 1 else "") or None,
                "commit": (parts[2] if len(parts) > 2 else "") or None,
            }
        )
        if len(found) >= MAX_REFS:
            break
    return found


def _parse_log(output: str) -> list[Commit]:
    commits = []
    for line in output.splitlines():
        parts = line.strip().split("|")
        if len(parts) < 6:
            continue
        # A subject may hold a "|": the fields after it are the last four.
        subject = "|".join(parts[2:-3])
        commits.append(Commit(parts[0], parts[1], subject, *parts[-3:]))
    return commits


def history_commits(clone: Path, history: GitHistory) -> list[Commit]:
    """The commits of the git-history mode."""
    args = ["log", _LOG_FORMAT, f"--max-count={MAX_COMMITS}"]
    if not history.include_merge_commits:
        args.append("--no-merges")
    revision: str | None = None
    if history.type == "recent":
        args.append(f"--max-count={history.count}")
    elif history.type == "since-date" and history.since_date:
        args.append(f"--since={history.since_date}")
    elif history.type == "tag-range" and history.from_tag:
        revision = f"{history.from_tag}..{history.to_tag or 'HEAD'}"
    elif history.type == "since-version" and history.from_tag:
        revision = f"{history.from_tag}..HEAD"
    if revision:
        args += ["--end-of-options", revision]
    return _parse_log(_git(clone, args))


def branch_diff_commits(clone: Path, diff: BranchDiff) -> list[Commit]:
    """The commits of ``compare_branch`` that ``base_branch`` has not."""
    args = [
        "log",
        _LOG_FORMAT,
        f"--max-count={MAX_COMMITS}",
        "--no-merges",
        "--end-of-options",
        f"{diff.base_branch}..{diff.compare_branch}",
    ]
    return _parse_log(_git(clone, args))


def existing_changelog(clone: Path) -> dict[str, object]:
    """The clone's ``CHANGELOG.md``, its beginning, and the last version it names."""
    path = clone / "CHANGELOG.md"
    if path.is_symlink() or not path.is_file():
        return {"exists": False}
    if not path.resolve().is_relative_to(clone.resolve()):
        return {"exists": False}
    with path.open(encoding="utf-8", errors="replace") as handle:
        content = handle.read(MAX_EXISTING)
    return {"exists": True, "content": content, "lastVersion": last_version(content)}
