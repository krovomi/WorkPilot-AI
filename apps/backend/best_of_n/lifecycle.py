"""Start, rank, adopt and discard a best-of-N run.

``prepare`` refuses a parent that has a build of its own: the winner becomes
the task's build, and there must be no other one for it to replace. The
variants' worktrees are created here, one after another, before any build
starts: N ``run.py`` processes creating theirs at once would fetch and write
refs in the same repository together.

``adopt`` makes the chosen variant the task's build, in the names every other
part of WorkPilot looks for (``workpilot/<task>``,
``.workpilot/worktrees/tasks/<task>``), and removes the others. It runs only
when the person asks for it, from the card, after a confirmation.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import get_git_executable
from review.state import ReviewState

from .rank import measure_variant, rank_variants
from .variants import (
    STATE_FILENAME,
    BestOfNError,
    Variant,
    copy_parent_spec,
    read_state,
    variant_spec_id,
    write_state,
)

__all__ = ["adopt", "discard", "prepare", "rank"]

OPEN_PHASES = ("running", "ranked")


def _now() -> str:
    return datetime.now(UTC).isoformat()


def _git(project: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(  # noqa: S603 - fixed argv
        [get_git_executable(), *args],
        cwd=str(project),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        check=False,
    )


def _worktree_path(project: Path, spec_id: str) -> Path:
    return project / ".workpilot" / "worktrees" / "tasks" / spec_id


def _branch(spec_id: str) -> str:
    return f"workpilot/{spec_id}"


def _branch_exists(project: Path, spec_id: str) -> bool:
    return (
        _git(
            project, "show-ref", "--verify", "--quiet", f"refs/heads/{_branch(spec_id)}"
        ).returncode
        == 0
    )


def _metadata(spec_dir: Path) -> dict:
    try:
        data = json.loads((spec_dir / "task_metadata.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _has_started(spec_dir: Path) -> bool:
    try:
        plan = json.loads(
            (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return False
    phases = plan.get("phases") if isinstance(plan, dict) else None
    for phase in phases if isinstance(phases, list) else []:
        for subtask in (phase.get("subtasks") or []) if isinstance(phase, dict) else []:
            if isinstance(subtask, dict) and subtask.get("status") not in (
                None,
                "pending",
            ):
                return True
    return False


def _remove_variant(project: Path, spec_dir: Path) -> list[str]:
    """Remove a variant's worktree, branch and spec directory; the failures."""
    problems: list[str] = []
    worktree = _worktree_path(project, spec_dir.name)
    if worktree.exists():
        done = _git(project, "worktree", "remove", "--force", str(worktree))
        if done.returncode != 0:
            problems.append(f"{spec_dir.name}: {done.stderr.strip()[:200]}")
    _git(project, "worktree", "prune")
    if _branch_exists(project, spec_dir.name):
        done = _git(project, "branch", "-D", _branch(spec_dir.name))
        if done.returncode != 0:
            problems.append(f"{spec_dir.name}: {done.stderr.strip()[:200]}")
    if spec_dir.is_dir() and not spec_dir.is_symlink():
        shutil.rmtree(spec_dir, ignore_errors=True)
    return problems


def prepare(
    project: Path,
    parent_dir: Path,
    variants: list[Variant],
    *,
    create_worktree=None,
) -> dict:
    """Create the variants' spec directories and worktrees; the new state."""
    parent_id = parent_dir.name
    if _metadata(parent_dir).get("bestOfN"):
        raise BestOfNError("this task is itself a variant")
    if not (parent_dir / "spec.md").is_file():
        raise BestOfNError("the task has no spec yet")
    state = read_state(parent_dir)
    if state and state.get("phase") in OPEN_PHASES:
        raise BestOfNError("a best-of-N run is already open for this task")
    if _worktree_path(project, parent_id).exists() or _branch_exists(
        project, parent_id
    ):
        raise BestOfNError(
            "the task already has a build; discard it before running best-of-N"
        )
    if _has_started(parent_dir):
        raise BestOfNError("the task's plan has already started")
    metadata = _metadata(parent_dir)
    if metadata.get("requireReviewBeforeCoding") and not ReviewState.load(
        parent_dir
    ).is_approval_valid(parent_dir):
        raise BestOfNError("the spec waits for its review; approve it first")

    entries: list[dict] = []
    for index in range(1, len(variants) + 1):
        spec_id = variant_spec_id(parent_id, index)
        if (
            (parent_dir.parent / spec_id).exists()
            or _worktree_path(project, spec_id).exists()
            or _branch_exists(project, spec_id)
        ):
            raise BestOfNError(
                f"{spec_id} is left over from an earlier run; discard it first"
            )

    if create_worktree is None:
        from core.worktree import WorktreeManager

        base = (
            metadata.get("baseBranch")
            if isinstance(metadata.get("baseBranch"), str)
            else None
        )
        manager = WorktreeManager(
            project,
            base_branch=base,
            use_local_branch=metadata.get("useLocalBranch") is True,
        )
        manager.setup()
        create_worktree = manager.create_worktree

    created: list[Path] = []
    try:
        for index, variant in enumerate(variants, start=1):
            spec_id = variant_spec_id(parent_id, index)
            variant_dir = parent_dir.parent / spec_id
            copy_parent_spec(parent_dir, variant_dir, parent_id, index, variant)
            created.append(variant_dir)
            create_worktree(spec_id)
            entries.append(
                {
                    "index": index,
                    "specId": spec_id,
                    "engine": variant.to_dict(),
                    "exitCode": None,
                }
            )
    except Exception as exc:
        for variant_dir in created:
            _remove_variant(project, variant_dir)
        if isinstance(exc, BestOfNError):
            raise
        raise BestOfNError(f"the variants could not be set up: {exc}") from exc

    new_state = {
        "parent": parent_id,
        "phase": "running",
        "createdAt": _now(),
        "variants": entries,
    }
    write_state(parent_dir, new_state)
    return new_state


def _open_state(parent_dir: Path) -> dict:
    state = read_state(parent_dir)
    if not state or state.get("phase") not in OPEN_PHASES:
        raise BestOfNError("there is no open best-of-N run for this task")
    variants = state.get("variants")
    if not isinstance(variants, list) or not variants:
        raise BestOfNError(f"{STATE_FILENAME} lists no variant")
    return state


def _entries(parent_dir: Path, state: dict) -> list[tuple[dict, Path]]:
    found = []
    for entry in state["variants"]:
        spec_id = entry.get("specId") if isinstance(entry, dict) else None
        index = entry.get("index") if isinstance(entry, dict) else None
        # The state file is ours, but a name read from disk is checked before
        # it becomes a path or a branch.
        if not isinstance(index, int) or spec_id != variant_spec_id(
            parent_dir.name, index
        ):
            raise BestOfNError(f"{STATE_FILENAME} names an unexpected variant")
        found.append((entry, parent_dir.parent / spec_id))
    return found


def rank(project: Path, parent_dir: Path, *, goal_runner=None) -> dict:
    """Measure and rank the variants; the state with its ranking."""
    state = _open_state(parent_dir)
    scores = []
    for entry, variant_dir in _entries(parent_dir, state):
        worktree = _worktree_path(project, variant_dir.name)
        scores.append(
            measure_variant(
                entry,
                variant_dir,
                worktree if worktree.is_dir() else None,
                parent_dir,
                goal_runner=goal_runner,
            )
        )
    summary = rank_variants(scores)
    state["phase"] = "ranked"
    state["ranking"] = {
        **summary,
        "at": _now(),
        "variants": [score.to_dict() for score in scores],
    }
    write_state(parent_dir, state)
    return state


# Files of a variant's spec directory that describe its own run, not the task.
_NOT_CARRIED = {"task_metadata.json", STATE_FILENAME}


def adopt(project: Path, parent_dir: Path, spec_id: str) -> dict:
    """Make ``spec_id`` the task's build and remove the other variants."""
    state = _open_state(parent_dir)
    entries = _entries(parent_dir, state)
    chosen = next(((e, d) for e, d in entries if d.name == spec_id), None)
    if chosen is None:
        raise BestOfNError("that variant is not part of this run")
    if any(e.get("exitCode") is None and not e.get("interrupted") for e, _ in entries):
        raise BestOfNError("a variant is still running")
    entry, variant_dir = chosen
    parent_id = parent_dir.name
    source = _worktree_path(project, spec_id)
    target = _worktree_path(project, parent_id)
    if not source.is_dir():
        raise BestOfNError("that variant has no worktree to adopt")
    if target.exists() or _branch_exists(project, parent_id):
        raise BestOfNError("the task already has a build")

    moved = _git(project, "worktree", "move", str(source), str(target))
    if moved.returncode != 0:
        raise BestOfNError(f"git worktree move failed: {moved.stderr.strip()[:200]}")
    renamed = _git(project, "branch", "-m", _branch(spec_id), _branch(parent_id))
    if renamed.returncode != 0:
        _git(project, "worktree", "move", str(target), str(source))
        raise BestOfNError(f"git branch -m failed: {renamed.stderr.strip()[:200]}")

    engine = Variant(**entry["engine"])
    metadata = _metadata(parent_dir)
    metadata.update(engine.engine_metadata())

    # The worktree's copy of the spec takes the task's name.
    specs = target / ".workpilot" / "specs"
    local = specs / spec_id
    if local.is_dir() and not local.is_symlink():
        destination = specs / parent_id
        if destination.exists():
            shutil.rmtree(destination)
        local.rename(destination)
        (destination / "task_metadata.json").write_text(
            json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8"
        )

    # The task's own directory gets what the build wrote.
    if variant_dir.is_dir() and not variant_dir.is_symlink():
        for item in variant_dir.iterdir():
            if item.name in _NOT_CARRIED or item.is_symlink():
                continue
            destination = parent_dir / item.name
            if item.is_dir():
                if destination.exists():
                    shutil.rmtree(destination)
                shutil.copytree(item, destination)
            else:
                shutil.copy2(item, destination)
    (parent_dir / "task_metadata.json").write_text(
        json.dumps(metadata, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    problems: list[str] = []
    for _entry, other in entries:
        if other.name == spec_id:
            if other.is_dir() and not other.is_symlink():
                shutil.rmtree(other, ignore_errors=True)
            continue
        problems += _remove_variant(project, other)

    state["phase"] = "adopted"
    state["adopted"] = {"specId": spec_id, "at": _now(), "cleanupProblems": problems}
    write_state(parent_dir, state)
    return state


def discard(project: Path, parent_dir: Path) -> dict:
    """Remove every variant; the task stays as it was before the run."""
    state = _open_state(parent_dir)
    problems: list[str] = []
    for _entry, variant_dir in _entries(parent_dir, state):
        problems += _remove_variant(project, variant_dir)
    state["phase"] = "discarded"
    state["discarded"] = {"at": _now(), "cleanupProblems": problems}
    write_state(parent_dir, state)
    return state
