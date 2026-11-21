"""Revert the deployed commit, by a pull request (#366).

A rollback puts the last good build back in production; the branch still
holds the bad commit, and the next deployment would ship it again. When the
project's `.workpilot/deploy-monitors.yaml` says `revert_pr: true`, a critical
verdict prepares the revert of the deployed commit on a branch of its own, in
a worktree of its own, and opens a pull request on the forge the project
already pushes to (GitHub, GitLab, Azure DevOps: the forge layer of `core`,
handed in by the runner as `OpenRevertPR`). Nothing is ever pushed to the
default branch: a person reviews and merges the PR.

The commit is the one the CI provider says it deployed (`plan.current_sha`),
checked as a commit id and as an ancestor of the branch the PR targets: a
pipeline run on a pull request's own branch has nothing to revert on it. A
merge commit is reverted against its first parent. A conflict aborts the
revert and opens nothing. git runs without a shell, arguments as a list.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from foundation.git_executable import run_git

_SHA = re.compile(r"^[0-9a-fA-F]{7,40}$")
_RUN_ID = re.compile(r"^[0-9]{1,20}$")
# A branch the run named: what git accepts, never an option or a range.
_BRANCH = re.compile(r"^(?!-)(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]{1,200}(?<![./])$")

# What became of the revert PR. "opened" and "exists" carry a link.
STATUSES = frozenset(
    {
        "opened",
        "exists",
        "failed",
        "conflict",
        "no_commit",
        "unknown_commit",
        "not_on_branch",
        "offline",
        "unavailable",
    }
)


@dataclass(frozen=True)
class RevertRequest:
    run_id: str
    sha: str
    title: str
    body: str
    # The branch the PR targets: the run's own, or "" for the default branch.
    target: str = ""

    @property
    def name(self) -> str:
        """The worktree's and the branch's name (`workpilot/<name>`)."""
        return f"deploy-revert-{self.run_id}"


# (request) -> {"status": one of STATUSES, "url": str, "provider": str}
OpenRevertPR = Callable[[RevertRequest], dict]


def revert_in(worktree: Path, sha: str) -> str:
    """Revert `sha` on the worktree's branch, as one commit; a status.

    "ready" when the revert commit is made; otherwise nothing is left behind.
    """
    if not _SHA.match(sha or ""):
        return "no_commit"
    if run_git(["cat-file", "-e", f"{sha}^{{commit}}"], cwd=worktree).returncode:
        return "unknown_commit"
    ancestor = run_git(["merge-base", "--is-ancestor", sha, "HEAD"], cwd=worktree)
    if ancestor.returncode == 1:
        return "not_on_branch"
    if ancestor.returncode:
        return "failed"
    parents = run_git(["rev-list", "--parents", "-n", "1", sha], cwd=worktree)
    if parents.returncode:
        return "failed"
    mainline = ["-m", "1"] if len(parents.stdout.split()) > 2 else []
    if run_git(["revert", "--no-edit", *mainline, sha], cwd=worktree).returncode:
        run_git(["revert", "--abort"], cwd=worktree)
        return "conflict"
    return "ready"


def _https(value: object) -> str:
    text = value if isinstance(value, str) else ""
    return text[:500] if text.startswith("https://") and " " not in text else ""


def target_branch(value: object) -> str:
    """The run's branch when it is a plain branch name, else "" (the default)."""
    name = value.strip() if isinstance(value, str) else ""
    name = name.removeprefix("refs/heads/")
    return name if _BRANCH.match(name) else ""


def request_for(run_id: str, sha: str, body: str, target: str = "") -> RevertRequest:
    short = sha[:12]
    return RevertRequest(
        run_id=run_id,
        sha=sha,
        target=target_branch(target),
        title=f"Revert {short}: deployment {run_id} failed its watch",
        body=(
            f"This reverts `{sha}`, the commit deployed by run {run_id}, "
            "which the deployment watch judged critical.\n\n"
            f"{body.strip()}\n\n"
            "Opened by WorkPilot's deployment watch. Review it before merging: "
            "a revert does not undo a database migration."
        ),
    )


def open_revert(
    run_id: str,
    sha: str,
    body: str,
    *,
    target: str = "",
    offline: bool,
    opener: OpenRevertPR | None,
) -> dict:
    """Open the revert PR through `opener`; what happened, always a dict."""
    if offline:
        return {"status": "offline"}
    if not _RUN_ID.match(run_id) or not _SHA.match(sha or ""):
        return {"status": "no_commit"}
    if opener is None:
        return {"status": "unavailable"}
    try:
        result = opener(request_for(run_id, sha, body, target))
    except (OSError, ValueError, RuntimeError) as error:
        return {"status": "failed", "error": type(error).__name__}
    result = result if isinstance(result, dict) else {}
    status = str(result.get("status") or "")
    out: dict = {"status": status if status in STATUSES else "failed", "sha": sha}
    if url := _https(result.get("url")):
        out["url"] = url
    if provider := str(result.get("provider") or "")[:30]:
        out["provider"] = provider
    return out
