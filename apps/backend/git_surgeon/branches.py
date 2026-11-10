"""Local branches worth a look: merged and left, stale, gone upstream, misnamed.

``list_branches`` reads them; ``delete_merged`` deletes only local branches
already merged into the default branch, with ``git branch -d`` (git itself
refuses a branch that is not merged), never the current branch, the default
branch or a branch checked out in another worktree. Remote branches are never
touched.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import run_git

from .commits import SurgeonError, current_branch, default_branch, git

STALE_DAYS = 90
MAX_BRANCHES = 500
_PROTECTED = {
    "main",
    "master",
    "develop",
    "trunk",
    "dev",
    "staging",
    "production",
    "release",
}
_NAMING = re.compile(
    r"^(feat|feature|fix|bugfix|hotfix|chore|docs|refactor|test|tests|ci|build|perf|release|"
    r"experiment|spike|dependabot|renovate|surgeon|claude|copilot|codex)/[\w.\-/]+$"
)
_PREFIX_WORDS = (
    ("fix", re.compile(r"(fix|bug|hotfix|patch)", re.I)),
    ("docs", re.compile(r"(doc|readme)", re.I)),
    ("chore", re.compile(r"(chore|bump|deps|cleanup)", re.I)),
    ("refactor", re.compile(r"refactor", re.I)),
    ("test", re.compile(r"test", re.I)),
)


def suggest_name(name: str) -> str:
    if name in _PROTECTED or _NAMING.match(name):
        return name
    rest = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:50] or "branch"
    prefix = next((p for p, regex in _PREFIX_WORDS if regex.search(name)), "feat")
    return f"{prefix}/{rest}"


def _worktree_branches(repo: Path) -> set[str]:
    out = run_git(["worktree", "list", "--porcelain"], cwd=repo).stdout
    return {
        line.split("refs/heads/", 1)[1]
        for line in out.splitlines()
        if line.startswith("branch refs/heads/")
    }


def list_branches(repo: Path, now: datetime | None = None) -> dict[str, object]:
    now = now or datetime.now(UTC)
    target = default_branch(repo)
    merged: set[str] = set()
    if target:
        merged = {
            line.strip().lstrip("*+ ").strip()
            for line in git(
                repo, "branch", "--format=%(refname:short)", "--merged", target
            ).splitlines()
        }
    out = git(
        repo,
        "for-each-ref",
        f"--count={MAX_BRANCHES}",
        "--format=%(refname:short)%00%(committerdate:iso-strict)%00%(upstream:short)%00%(upstream:track)",
        "refs/heads",
    )
    current = current_branch(repo)
    in_worktrees = _worktree_branches(repo)
    rows = []
    for line in out.splitlines():
        parts = line.split("\x00")
        if len(parts) != 4:
            continue
        name, date, upstream, track = parts
        try:
            age = (now - datetime.fromisoformat(date)).days
        except ValueError:
            age = 0
        protected = name in _PROTECTED or name == target.split("/")[-1]
        rows.append(
            {
                "name": name,
                "lastCommitAt": date,
                "ageDays": max(0, age),
                "upstream": upstream,
                "gone": "gone" in track,
                "merged": name in merged and not protected,
                "stale": age > STALE_DAYS,
                "current": name == current,
                "protected": protected,
                "checkedOut": name in in_worktrees and name != current,
                "suggestedName": suggest_name(name),
            }
        )
    rows.sort(key=lambda r: (not r["merged"], not r["gone"], -int(r["ageDays"])))
    return {"defaultBranch": target, "branches": rows}


def delete_merged(repo: Path, names: object) -> dict[str, object]:
    if not isinstance(names, list) or len(names) > MAX_BRANCHES:
        raise SurgeonError("no branch list")
    listing = {b["name"]: b for b in list_branches(repo)["branches"]}  # type: ignore[index]
    deleted: list[str] = []
    refused: dict[str, str] = {}
    for name in names:
        if not isinstance(name, str) or name not in listing:
            refused[str(name)[:80]] = "unknown"
            continue
        row = listing[name]
        if row["current"] or row["protected"] or row["checkedOut"]:
            refused[name] = "in_use"
        elif not row["merged"]:
            refused[name] = "not_merged"
        else:
            result = run_git(["branch", "-d", "--", name], cwd=repo)
            if result.returncode == 0:
                deleted.append(name)
            else:
                refused[name] = "git_refused"
    return {"deleted": deleted, "refused": refused}
