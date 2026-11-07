"""Publish a task stacked on another one (killer feature F6).

A task B "stacked on" A starts from A's branch: its ``task_metadata.json``
holds ``baseBranch = workpilot/<A>``, ``useLocalBranch`` (so the worktree
starts from A's local commit, not a stale ``origin/workpilot/<A>``),
``stackParent = <A>``, ``stackParentSha`` (A's commit when B was last put on
it) and ``stackTrunk`` (the branch A itself goes to). The desktop app writes
them (``stack-handlers.ts``) and keeps B up to date; this module is the PR
side:

- before B's PR is created, A's branch is pushed: GitHub needs the base to
  exist on the remote, and B's PR then shows B's diff only;
- after it, when the official ``gh stack`` extension is installed, the two
  PRs are linked as a stack (``gh stack link --base <trunk> <A> <B>``, which
  keeps no local state). Without it, the PR targeting A's branch is the
  fallback. A failure to link (exit 4: GitHub API, 8: stack locked) never
  undoes the PR: it is created, and the result says the link failed.

Every branch name goes through ``validate_branch_name``; ``git`` and ``gh``
get argument lists (rule 6).
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
from pathlib import Path

from foundation.base_branch import validate_branch_name

logger = logging.getLogger(__name__)

__all__ = [
    "StackInfo",
    "gh_stack_available",
    "link_stack",
    "stack_info",
]

BRANCH_PREFIX = "workpilot/"
#: A spec folder name, as WorkPilot writes them (``001-add-login``).
_SPEC = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,200}$")
_LINK_ERRORS = {
    3: "a rebase conflict in the stack",
    4: "the GitHub API refused the stack",
    8: "the stack is locked by another process",
}


class StackInfo:
    """What a stacked task's metadata says, checked."""

    def __init__(self, parent: str, parent_branch: str, trunk: str | None):
        self.parent = parent
        self.parent_branch = parent_branch
        self.trunk = trunk


def _metadata(spec_dir: Path) -> dict:
    try:
        data = json.loads((spec_dir / "task_metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def stack_info(spec_dir: Path, target_branch: str | None) -> StackInfo | None:
    """The stack B belongs to, when its PR targets its parent's branch."""
    data = _metadata(spec_dir)
    parent = data.get("stackParent")
    if not isinstance(parent, str) or not _SPEC.match(parent):
        return None
    parent_branch = validate_branch_name(BRANCH_PREFIX + parent)
    if parent_branch is None or parent_branch != target_branch:
        return None
    trunk = validate_branch_name(data.get("stackTrunk"))
    return StackInfo(parent, parent_branch, trunk)


def gh_stack_available(gh: str, cwd: Path) -> bool:
    """Whether the ``gh stack`` extension is installed (never offers to install it)."""
    try:
        listed = subprocess.run(
            [gh, "extension", "list"],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return listed.returncode == 0 and "gh-stack" in listed.stdout


def link_stack(gh: str, cwd: Path, trunk: str, branches: list[str]) -> tuple[bool, str]:
    """``gh stack link --base <trunk> <branches…>``: (linked, why not)."""
    names = [validate_branch_name(b) for b in branches]
    base = validate_branch_name(trunk)
    if base is None or any(n is None for n in names):
        return False, "a branch name was refused"
    try:
        result = subprocess.run(
            [gh, "stack", "link", "--base", base, *[n for n in names if n]],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return False, f"gh stack could not run ({type(exc).__name__})"
    if result.returncode == 0:
        return True, ""
    why = _LINK_ERRORS.get(result.returncode, f"gh stack exited {result.returncode}")
    logger.warning("gh stack link failed: %s", why)
    return False, why


def spec_dir_of(manager, spec_name: str) -> Path:
    """The task's spec directory the desktop app writes (the project's copy)."""
    main = Path(manager.project_dir) / ".workpilot" / "specs" / spec_name
    if main.is_dir():
        return main
    return (
        Path(manager.get_worktree_path(spec_name)) / ".workpilot" / "specs" / spec_name
    )


def push_parent(manager, stack: StackInfo) -> str | None:
    """Push A's branch so B's PR can target it; the error, or None."""
    if manager.worktree_exists(stack.parent):
        pushed = manager.push_branch(stack.parent)
        if pushed.get("success"):
            return None
        return f"Could not push the stack's parent {stack.parent_branch}: {pushed.get('error', '')}"
    # A's worktree was removed: its branch may still exist in the project.
    result = manager._run_git(
        ["push", "-u", "origin", stack.parent_branch], cwd=manager.project_dir
    )
    if result.returncode == 0:
        return None
    return f"Could not push the stack's parent {stack.parent_branch}: {result.stderr.strip()[:300]}"


def link_after_pr(
    manager, stack: StackInfo, spec_name: str, gh: str | None
) -> tuple[bool, str]:
    """Link A and B as a GitHub stack when ``gh stack`` is there; (linked, note)."""
    if not gh or not stack.trunk:
        return False, "no trunk recorded for the stack" if gh else "gh not found"
    if not gh_stack_available(gh, Path(manager.project_dir)):
        return False, "gh stack is not installed: the PR targets the parent's branch"
    return link_stack(
        gh,
        Path(manager.project_dir),
        stack.trunk,
        [stack.parent_branch, manager.get_branch_name(spec_name)],
    )
