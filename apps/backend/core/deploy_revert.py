"""The forge side of a deployment's revert PR (#366, `deploy_watch.revert`).

`deploy_watch` is a leaf that imports nothing of `core`; the deployment watch
runner hands it `open_revert_pr(project_dir)`. The revert is made in a
worktree of `WorktreeManager` (`.workpilot/worktrees/tasks/deploy-revert-<run>`,
branch `workpilot/deploy-revert-<run>`, cut from the remote's copy of the
target branch), and `push_and_create_pr` pushes that branch and opens the PR
on whichever forge the project's remote is (GitHub, GitLab, Azure DevOps),
with the credentials it already uses. The default branch is never pushed to.
The worktree is removed afterwards; the branch stays only once pushed.
"""

from __future__ import annotations

import logging
from pathlib import Path

from core.worktree import WorktreeManager
from core.worktree_common import WorktreeError
from deploy_watch.revert import OpenRevertPR, RevertRequest, revert_in

logger = logging.getLogger(__name__)


def _cleanup(manager: WorktreeManager, name: str, pushed: bool) -> None:
    try:
        manager.remove_worktree(name, delete_branch=not pushed)
    except (RuntimeError, WorktreeError, OSError) as error:
        logger.warning("revert worktree %s left in place: %s", name, error)


def open_revert_pr(project_dir: Path) -> OpenRevertPR:
    """The opener `deploy_watch.watch.run_watch` calls on a critical verdict."""

    def open_(request: RevertRequest) -> dict:
        manager = WorktreeManager(Path(project_dir), base_branch=request.target or None)
        name = request.name
        if manager._branch_exists(manager.get_branch_name(name)):
            url = manager.find_existing_pr_url(name, manager.base_branch) or ""
            return {"status": "exists", "url": url}
        try:
            info = manager.create_worktree(name)
        except (WorktreeError, ValueError, OSError) as error:
            logger.warning("revert worktree not created: %s", error)
            return {"status": "failed"}
        pushed = False
        try:
            status = revert_in(info.path, request.sha)
            if status != "ready":
                return {"status": status}
            result = manager.push_and_create_pr(
                name,
                target_branch=manager.base_branch,
                title=request.title,
                body=request.body,
            )
            pushed = bool(result.get("pushed"))
            if not result.get("success"):
                logger.warning("revert PR not opened: %s", result.get("error", ""))
                return {"status": "failed", "provider": result.get("provider", "")}
            return {
                "status": "exists" if result.get("already_exists") else "opened",
                "url": result.get("pr_url") or "",
                "provider": result.get("provider", ""),
            }
        finally:
            _cleanup(manager, name, pushed)

    return open_
