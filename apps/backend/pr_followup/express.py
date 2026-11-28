"""Express lane: a project's own dependency PRs merged by themselves in N0.

Dependabot and Renovate open pull requests on the person's projects that no
task wrote. When the app enforces the approval tiers and the person turned
the express lane on, each such PR whose checks all passed is judged by the
approvals engine (the title gives the bump and its level; a bump is N0, so no
cross-review is needed) and merged when ``Decision.merges`` says so, at
exactly the head that was judged. Anything else is left to a person:

- an author that is not one of the two bots, a draft, a fork;
- a check that failed or still runs, or no check at all;
- a change set git cannot list, a tier above N0 (major bump, CI files…);
- off or observe mode: the decision is printed, nothing merges.

GitHub only, through ``gh`` (argument lists, the repository named by ``-R``).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from foundation.git_executable import run_git

from .forge import GhRun, GitHubForge, GitHubPR
from .model import CheckState, PRSnapshot

BOT_AUTHORS = frozenset(
    {"app/dependabot", "dependabot[bot]", "app/renovate", "renovate[bot]"}
)
MAX_PRS = 50
_OWNER = r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})"
_REPO = r"[A-Za-z0-9._-]{1,100}"
_REMOTE = re.compile(
    rf"^(?:https://github\.com/|git@github\.com:|ssh://git@github\.com/)"
    rf"(?P<owner>{_OWNER})/(?P<repo>{_REPO}?)(?:\.git)?/?$"
)
_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$")

Emit = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class Candidate:
    number: int
    title: str
    author: str


def github_slug(project: Path) -> tuple[str, str] | None:
    """(owner, repo) of the project's ``origin`` on github.com, else None."""
    result = run_git(["remote", "get-url", "origin"], cwd=project)
    if result.returncode != 0:
        return None
    match = _REMOTE.match(result.stdout.strip())
    if not match or match["repo"] in (".", ".."):
        return None
    return match["owner"], match["repo"]


def candidates(raw: str) -> list[Candidate]:
    """The open PRs of the two bots, from ``gh pr list --json``; never a draft."""
    try:
        rows = json.loads(raw or "[]")
    except ValueError:
        return []
    out: list[Candidate] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict) or row.get("isDraft"):
            continue
        author = (
            (row.get("author") or {}).get("login")
            if isinstance(row.get("author"), dict)
            else None
        )
        number = row.get("number")
        if author not in BOT_AUTHORS or not isinstance(number, int) or number < 1:
            continue
        if row.get("isCrossRepository"):
            continue
        out.append(Candidate(number, str(row.get("title") or "")[:300], author))
    return out[:MAX_PRS]


def all_passed(snap: PRSnapshot) -> bool:
    return (
        not snap.error
        and bool(snap.checks)
        and all(c.state == CheckState.PASSED for c in snap.checks)
        and not snap.threads
    )


def _fetch(project: Path, number: int, base: str) -> bool:
    if not _BRANCH.match(base or "") or ".." in base:
        return False
    fetched = run_git(
        [
            "fetch",
            "--no-tags",
            "origin",
            f"+refs/heads/{base}:refs/remotes/origin/{base}",
            f"+refs/pull/{number}/head:refs/workpilot/express/{number}",
        ],
        cwd=project,
        timeout=120,
    )
    return fetched.returncode == 0


def judge(project: Path, snap: PRSnapshot) -> dict[str, Any]:
    """The tier of a green bot PR, as ``Decision.to_dict()``, or an ``error``."""
    from approvals import (
        build_facts,
        changed_files,
        clean_layers_touched,
        decide,
        load_approval_policy,
    )

    if not _fetch(project, snap.number, snap.base_branch):
        return {"error": "git could not fetch the pull request"}
    files = changed_files(project, f"origin/{snap.base_branch}", snap.head_sha)
    if files is None:
        return {"error": "git could not list the change set of the pull request"}
    facts = build_facts(
        files,
        title=snap.title,
        base=snap.base_branch,
        labels=list(snap.labels),
        ci="green",
        review="none",
        layers=clean_layers_touched(project, [f.path for f in files]),
    )
    return decide(facts, load_approval_policy(project)).to_dict()


async def run_lane(project: Path, gh: GhRun, emit: Emit) -> dict[str, Any]:
    """One pass over the project's bot PRs. Returns the counts."""
    from approvals import MODE_OFF, app_mode

    if app_mode() == MODE_OFF:
        return {"skipped": "approval tiers are off"}
    slug = github_slug(project)
    if slug is None:
        return {"skipped": "origin is not a GitHub repository"}
    owner, repo = slug
    code, out, err = await gh(
        [
            "pr",
            "list",
            "-R",
            f"{owner}/{repo}",
            "--state",
            "open",
            "--limit",
            str(MAX_PRS),
            "--json",
            "number,title,author,isDraft,isCrossRepository",
        ]
    )
    if code != 0:
        return {"error": (err or "gh pr list failed").strip().splitlines()[0][:300]}
    seen = merged = 0
    for pr in candidates(out):
        seen += 1
        forge = GitHubForge(GitHubPR(owner, repo, pr.number), gh)
        snap = await forge.snapshot()
        line: dict[str, Any] = {"pr": pr.number, "author": pr.author}
        if not all_passed(snap):
            emit({**line, "skipped": "checks not all passed"})
            continue
        try:
            decision = judge(project, snap)
        except (OSError, ValueError) as exc:
            decision = {"error": str(exc)[:300]}
        if decision.get("error"):
            emit({**line, "skipped": decision["error"]})
            continue
        line.update(
            tier=decision.get("tier"),
            action=decision.get("action"),
            mode=decision.get("mode"),
            merged=False,
        )
        if decision.get("merges") is True:
            ok, error = await forge.merge(snap.head_sha)
            line["merged"] = ok
            if not ok:
                line["mergeError"] = error[:300]
            merged += int(ok)
        emit(line)
    return {"seen": seen, "merged": merged}


__all__ = [
    "BOT_AUTHORS",
    "Candidate",
    "all_passed",
    "candidates",
    "github_slug",
    "judge",
    "run_lane",
]
