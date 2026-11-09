"""
Review worktree runner — the Kanban's worktree for code a page generates.

A page that writes code into a project (the test studio, Import Design, the
changelog, pair programming) must not write into the person's checkout: the
code would land on whatever branch is checked out, ``develop`` or ``main``
included, with no review. It writes into the worktree of a Kanban card
instead, on the card's own branch ``workpilot/<spec>``, and the person opens
the pull request from the card like for any task. This runner is the one
place that worktree is made and committed, through the same
``core.worktree.WorktreeManager`` the Kanban pipeline uses, so the branch
name, the base branch, the pruning and the build-artifact excludes are the
Kanban's.

Actions (one ``__REVIEW_WORKTREE__:<json>`` line on stdout, or
``__REVIEW_WORKTREE_ERROR__:<message>`` and exit code 1):

  create:  {"path": "...", "branch": "workpilot/<spec>", "base_branch": "develop"}
  commit:  {"committed": true, "files": ["tests/test_x.py", ...]}

Usage::

    python review_worktree_runner.py --action create --project-dir <root> --spec <id> [--base-branch develop]
    python review_worktree_runner.py --action commit --project-dir <root> --spec <id> --message "..."
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from core.worktree import WorktreeError, WorktreeManager  # noqa: E402
from foundation.git_executable import run_git  # noqa: E402

RESULT_PREFIX = "__REVIEW_WORKTREE__:"
ERROR_PREFIX = "__REVIEW_WORKTREE_ERROR__:"


def _emit(payload: dict) -> None:
    print(f"{RESULT_PREFIX}{json.dumps(payload)}", flush=True)


def _fail(message: str) -> int:
    # One line: the main process shows it as is.
    print(f"{ERROR_PREFIX}{' '.join(message.split())}", flush=True)
    return 1


def _manager(args: argparse.Namespace) -> WorktreeManager:
    project_dir = Path(args.project_dir).resolve()
    inside = run_git(["rev-parse", "--is-inside-work-tree"], cwd=project_dir)
    if inside.returncode != 0 or inside.stdout.strip() != "true":
        raise WorktreeError(f"{project_dir} is not a git repository")
    return WorktreeManager(project_dir, base_branch=args.base_branch or None)


def _cmd_create(args: argparse.Namespace) -> int:
    manager = _manager(args)
    # The spec name is validated by the manager (no separator, no "..").
    info = manager.get_or_create_worktree(args.spec)
    _emit(
        {
            "path": str(info.path),
            "branch": info.branch,
            "base_branch": info.base_branch or manager.base_branch,
        }
    )
    return 0


def _changed_files(manager: WorktreeManager, spec: str) -> list[str]:
    """What the last commit of the card's branch changed, relative paths."""
    result = run_git(
        ["diff", "--name-only", "HEAD~1", "HEAD"],
        cwd=manager.get_worktree_path(spec),
    )
    if result.returncode != 0:
        return []
    return [line for line in result.stdout.splitlines() if line.strip()]


def _commit_failure(worktree: Path) -> str:
    """Why git refused the commit, in words the person can act on."""
    # The usual cause on a fresh machine: git does not know who commits.
    for ident in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
        if run_git(["var", ident], cwd=worktree).returncode != 0:
            return (
                "git has no author identity for this repository: set "
                "user.name and user.email (git config --global), then try again"
            )
    return "git commit failed in the card's worktree"


def _cmd_commit(args: argparse.Namespace) -> int:
    manager = _manager(args)
    if not manager.worktree_exists(args.spec):
        return _fail(f"No worktree for {args.spec}")
    worktree = manager.get_worktree_path(args.spec)
    before = run_git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()
    if not manager.commit_in_worktree(args.spec, args.message):
        return _fail(_commit_failure(worktree))
    after = run_git(["rev-parse", "HEAD"], cwd=worktree).stdout.strip()
    committed = bool(after) and after != before
    _emit(
        {
            "committed": committed,
            "files": _changed_files(manager, args.spec) if committed else [],
        }
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Review worktree runner")
    parser.add_argument("--action", required=True, choices=["create", "commit"])
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--spec", required=True)
    parser.add_argument("--base-branch", default=None)
    parser.add_argument("--message", default="chore: generated code")
    args = parser.parse_args()
    try:
        if args.action == "create":
            return _cmd_create(args)
        return _cmd_commit(args)
    except (WorktreeError, ValueError, OSError) as exc:
        return _fail(str(exc))


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
