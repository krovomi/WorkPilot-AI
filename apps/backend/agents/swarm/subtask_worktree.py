"""One git worktree per subtask of a swarm wave, merged back into the task.

Two coders writing in the same working tree see each other's half-written
files and stage each other's changes. So each subtask of a wave gets its own
worktree, on its own branch, started from the task's branch as it stands
before the wave. When the wave is over, the branch of each subtask that
finished is merged into the task's branch, one after the other, and the
subtask's entry in the task's plan takes what its coder recorded.

A merge that conflicts is aborted: the task's branch is left as it was and the
subtask stays pending in the task's plan, so the task's own coder does it
afterwards, on top of everything the wave merged.
"""

from __future__ import annotations

import json
import re
import shutil
from dataclasses import dataclass
from pathlib import Path

from foundation.file_utils import write_json_atomic
from foundation.git_executable import run_git
from security.constants import ALLOWLIST_FILENAME, PROFILE_FILENAME

PLAN_FILE = "implementation_plan.json"
_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")

# WorkPilot's own files never reach a commit (see WorktreeManager.commit_in_worktree).
_STAGE = ["add", "-A", "--", ".", ":!.workpilot", ":!.workpilot-*"]


class SubtaskWorktreeError(RuntimeError):
    """A subtask's worktree could not be created."""


@dataclass(frozen=True)
class SubtaskWorktree:
    """Where one subtask is built, and the branch that carries its work."""

    subtask_id: str
    path: Path
    branch: str
    spec_dir: Path


def _git(args: list[str], cwd: Path, timeout: int = 120):
    return run_git(args, cwd=cwd, timeout=timeout)


def _main_checkout(task_dir: Path) -> Path:
    """The repository's main checkout, whatever worktree ``task_dir`` is."""
    result = _git(["rev-parse", "--path-format=absolute", "--git-common-dir"], task_dir)
    if result.returncode != 0:
        raise SubtaskWorktreeError(f"Not a git checkout: {task_dir}")
    return Path(result.stdout.strip()).parent


def is_checkout(task_dir: Path) -> bool:
    """Whether ``task_dir`` is the root of a git checkout (a task's worktree)."""
    result = _git(["rev-parse", "--show-toplevel"], task_dir)
    if result.returncode != 0:
        return False
    return Path(result.stdout.strip()).resolve() == Path(task_dir).resolve()


def is_clean(task_dir: Path) -> bool:
    """Whether the task's branch holds all its work (WorkPilot's files aside).

    The subtasks start from the branch: work left uncommitted in the task's
    worktree would be missing from every one of them.
    """
    result = _git(
        ["status", "--porcelain", "--", ".", ":!.workpilot", ":!.workpilot-*"],
        task_dir,
    )
    return result.returncode == 0 and not result.stdout.strip()


def _slug(text: str) -> str:
    return _UNSAFE.sub("-", text).strip("-.") or "subtask"


def create(task_dir: Path, spec_dir: Path, subtask_id: str) -> SubtaskWorktree:
    """Give ``subtask_id`` its own worktree, started from the task's branch.

    The worktree gets the task's spec (the coder reads its plan there), its
    environment and security files, and ``.workpilot/`` stays out of git.
    """
    main = _main_checkout(task_dir)
    spec_name = spec_dir.name
    slug = _slug(subtask_id)
    path = main / ".workpilot" / "worktrees" / "swarm" / spec_name / slug
    branch = f"workpilot/swarm/{_slug(spec_name)}/{slug}"

    # A previous run that stopped half way left these behind.
    remove(task_dir, path, branch)
    path.parent.mkdir(parents=True, exist_ok=True)
    result = _git(["worktree", "add", "-b", branch, str(path), "HEAD"], task_dir)
    if result.returncode != 0:
        raise SubtaskWorktreeError(
            f"Could not create the worktree of subtask {subtask_id}: "
            f"{(result.stderr or result.stdout).strip()}"
        )

    from core.workspace.workspace_setup import (
        copy_env_files_to_worktree,
        prepare_worktree_dependencies,
    )
    from init import ensure_gitignore_entry

    # Prepared like the task's own worktree (core.workspace.setup_workspace),
    # with the security files the task's worktree already holds.
    copy_env_files_to_worktree(main, path)
    prepare_worktree_dependencies(main, path, spec_name)
    for name in (ALLOWLIST_FILENAME, PROFILE_FILENAME):
        if (task_dir / name).is_file():
            shutil.copy2(task_dir / name, path / name)
    ensure_gitignore_entry(path, ".workpilot/")
    worktree_spec = path / ".workpilot" / "specs" / spec_name
    shutil.copytree(spec_dir, worktree_spec)
    return SubtaskWorktree(subtask_id, path, branch, worktree_spec)


def _subtask(plan: dict, subtask_id: str) -> dict | None:
    for phase in plan.get("phases", []):
        for subtask in phase.get("subtasks", phase.get("chunks", [])):
            if subtask.get("id") == subtask_id:
                return subtask
    return None


def _read_plan(spec_dir: Path) -> dict:
    try:
        plan = json.loads((spec_dir / PLAN_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return plan if isinstance(plan, dict) else {}


def finished(worktree: SubtaskWorktree) -> bool:
    """Whether the subtask's coder marked it completed in its copy of the plan."""
    entry = _subtask(_read_plan(worktree.spec_dir), worktree.subtask_id)
    return bool(entry) and entry.get("status") == "completed"


def merge(task_dir: Path, spec_dir: Path, worktree: SubtaskWorktree) -> bool:
    """Bring a finished subtask's work into the task's branch and plan.

    Returns False, with the task's branch and plan left as they were, when the
    work cannot be committed or its merge conflicts.
    """
    _git(_STAGE, worktree.path)
    committed = _git(
        ["commit", "-m", f"workpilot: subtask {worktree.subtask_id}"], worktree.path
    )
    if committed.returncode != 0 and "nothing to commit" not in (
        committed.stdout + committed.stderr
    ):
        return False

    merged = _git(
        [
            "merge",
            "--no-ff",
            "-m",
            f"workpilot: merge subtask {worktree.subtask_id}",
            worktree.branch,
        ],
        task_dir,
    )
    if merged.returncode != 0:
        _git(["merge", "--abort"], task_dir)
        return False

    plan = _read_plan(spec_dir)
    entry = _subtask(plan, worktree.subtask_id)
    done = _subtask(_read_plan(worktree.spec_dir), worktree.subtask_id)
    if entry is not None and done is not None:
        entry.clear()
        entry.update(done)
        write_json_atomic(spec_dir / PLAN_FILE, plan, indent=2)
    return True


def remove(task_dir: Path, path: Path, branch: str) -> None:
    """Delete a subtask's worktree and branch; nothing there is nothing to do."""
    if path.exists():
        _git(["worktree", "remove", "--force", str(path)], task_dir)
        shutil.rmtree(path, ignore_errors=True)
    _git(["worktree", "prune"], task_dir)
    _git(["branch", "-D", branch], task_dir)
