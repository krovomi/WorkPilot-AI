"""The captures of a task in its pull request, on demand from the app.

`push_and_create_pr` already fills the "Captures" section when it opens the
pull request. This runner does it again when the captures change afterwards,
or when a person publishes or withdraws them (``CAPTURES_PUBLISH=review``):

  sync      host the publishable copies and update the section
  approve   publish the current copies (review mode), then sync
  withdraw  forget the approval, then sync (the section and images go)

One JSON line on stdout: ``{"result": {...pr-sync.json...}}`` or
``{"error": "..."}``.

Usage::

    python pr_captures_runner.py sync --project-dir <root> --spec-name <name> \\
        [--target-branch <branch>]

The pull request is the one open for the task's branch, looked up on the
forge: the caller does not name it, so no other pull request can be edited.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

_SPEC_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_BRANCH = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")


def _emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


def run(args: argparse.Namespace) -> dict:
    from core.capture_hosting import sync_after_pr, task_spec_dir
    from core.worktree import WorktreeManager
    from foundation.git_provider import detect_git_provider
    from pr_captures.approval import approve, revoke

    if not _SPEC_NAME.match(args.spec_name or ""):
        raise ValueError("invalid spec name")
    if args.target_branch and (
        not _BRANCH.match(args.target_branch) or ".." in args.target_branch
    ):
        raise ValueError("invalid target branch")
    project = Path(args.project_dir).resolve(strict=True)
    manager = WorktreeManager(project)
    spec = task_spec_dir(manager, args.spec_name).resolve()
    if spec == project or not spec.is_relative_to(project):
        raise ValueError("the spec directory is outside the project")
    if args.command == "approve":
        approve(spec)
    elif args.command == "withdraw":
        revoke(spec)
    pr_url = manager.find_existing_pr_url(args.spec_name, args.target_branch)
    if not pr_url:
        return {"status": "no-pr"}
    return sync_after_pr(
        manager, args.spec_name, detect_git_provider(project), pr_url, None
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("command", choices=("sync", "approve", "withdraw"))
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--spec-name", required=True)
    parser.add_argument("--target-branch")
    args = parser.parse_args(argv)
    from core.worktree_common import WorktreeError

    try:
        _emit({"result": run(args)})
    except (OSError, ValueError, WorktreeError) as exc:
        _emit({"error": str(exc)})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
