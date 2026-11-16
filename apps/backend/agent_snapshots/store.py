"""Git snapshots of a task's worktree, and the rollback to one.

Taken before every agent session (``agents.safety_watch``), in the task's own
worktree (``.workpilot/worktrees/tasks/<task>``), whatever its language: a
snapshot is a commit object under ``refs/workpilot/snapshots/<task>/<id>``
whose tree is the worktree as it was (tracked files with their edits, plus
the untracked files git does not ignore) and whose parent is the HEAD of the
moment. Built in a copy of the index, so neither the branch, nor the index,
nor the files move; ignored files (``node_modules``, ``bin``, ``obj``,
``.venv``…) are not copied, which is what keeps it cheap on any stack. The
spec directory under ``.workpilot/`` is left out: the build's own state is
not the agent's work.

Rollback puts the branch back on the snapshot's parent, removes the files
added since (never the ignored ones nor ``.workpilot/``), then writes the
snapshot's tree back. It first takes a snapshot of the state it is about to
replace, so a rollback can itself be undone.

Only a task worktree is ever rolled back: the main checkout holds the
person's own work. The commits stay in the object store until git's garbage
collection; older refs are pruned beyond ``keep`` per task.
"""

from __future__ import annotations

import re
import shutil
import tempfile
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from foundation.git_executable import get_isolated_git_env, run_git

NAMESPACE = "refs/workpilot/snapshots"

#: A task name usable as one ref component (what spec folders are named).
_TASK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$")
#: What this module names a snapshot: a UTC timestamp and a label.
_SNAPSHOT_ID = re.compile(r"^\d{8}T\d{12}Z-[a-z_]{1,32}$")
_LABEL = re.compile(r"^[a-z_]{1,32}$")

_IDENTITY = {
    "GIT_AUTHOR_NAME": "WorkPilot snapshot",
    "GIT_AUTHOR_EMAIL": "snapshot@workpilot.invalid",
    "GIT_COMMITTER_NAME": "WorkPilot snapshot",
    "GIT_COMMITTER_EMAIL": "snapshot@workpilot.invalid",
}


class SnapshotError(RuntimeError):
    """A snapshot or a rollback that could not be done, with the reason."""


@dataclass(frozen=True)
class Snapshot:
    snapshot_id: str
    commit: str
    head: str
    created_at: str
    label: str

    def to_dict(self) -> dict[str, str]:
        return asdict(self)


def valid_task_name(task: str) -> bool:
    return (
        isinstance(task, str)
        and bool(_TASK.match(task))
        and ".." not in task
        and not task.endswith((".lock", "."))
    )


def valid_snapshot_id(snapshot_id: str) -> bool:
    return isinstance(snapshot_id, str) and bool(_SNAPSHOT_ID.match(snapshot_id))


def task_worktree(spec_dir: Path | str) -> tuple[Path, str] | None:
    """The task worktree a spec directory belongs to, and the task's name.

    ``<root>/.workpilot/worktrees/tasks/<task>/.workpilot/specs/<task>``: a
    build in a worktree. Anything else (a direct build in the project, a
    spec being written) is not a worktree, and gets no snapshot.
    """
    try:
        parts = Path(spec_dir).resolve().parts
    except (OSError, RuntimeError, ValueError):
        return None
    for i in range(len(parts) - 3):
        if parts[i : i + 3] == (".workpilot", "worktrees", "tasks"):
            task = parts[i + 3]
            root = Path(*parts[: i + 4])
            if valid_task_name(task) and (root / ".git").exists():
                return root, task
    return None


def worktree_of(project_dir: Path | str, task: str) -> Path:
    """The worktree of ``task`` in ``project_dir``, checked to be one."""
    if not valid_task_name(task):
        raise SnapshotError("invalid task name")
    root = Path(project_dir).resolve() / ".workpilot" / "worktrees" / "tasks" / task
    if not (root / ".git").exists():
        raise SnapshotError("the task has no worktree")
    top = _git(root, "rev-parse", "--show-toplevel")
    if Path(top).resolve() != root.resolve():
        raise SnapshotError("the task's folder is not its own worktree")
    return root


def _git(
    cwd: Path, *args: str, env: dict[str, str] | None = None, timeout: int = 120
) -> str:
    result = run_git(list(args), cwd=cwd, env=env, timeout=timeout)
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "").strip().splitlines()
        raise SnapshotError(
            f"git {args[0]} failed: {message[-1] if message else result.returncode}"
        )
    return result.stdout.strip()


def _env(index_file: Path | None = None) -> dict[str, str]:
    env = get_isolated_git_env()
    env.update(_IDENTITY)
    if index_file is not None:
        env["GIT_INDEX_FILE"] = str(index_file)
    return env


def _ref(task: str, snapshot_id: str = "") -> str:
    return (
        f"{NAMESPACE}/{task}/{snapshot_id}" if snapshot_id else f"{NAMESPACE}/{task}/"
    )


def _new_id(label: str) -> str:
    return datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ") + f"-{label}"


class _ScratchIndex:
    """A throwaway copy of the worktree's index (its stat cache keeps it fast)."""

    def __init__(self, worktree: Path) -> None:
        self.worktree = worktree
        self.folder = Path(tempfile.mkdtemp(prefix="workpilot-snapshot-"))
        self.path = self.folder / "index"

    def __enter__(self) -> Path:
        real = Path(_git(self.worktree, "rev-parse", "--git-path", "index"))
        if not real.is_absolute():
            real = self.worktree / real
        if real.is_file():
            shutil.copyfile(real, self.path)
        return self.path

    def __exit__(self, *_exc: object) -> None:
        shutil.rmtree(self.folder, ignore_errors=True)


def list_snapshots(worktree: Path, task: str) -> list[Snapshot]:
    """The task's snapshots, newest first."""
    if not valid_task_name(task):
        raise SnapshotError("invalid task name")
    out = _git(
        worktree,
        "for-each-ref",
        "--sort=-refname",
        "--format=%(refname)%00%(objectname)%00%(parent)%00%(creatordate:iso-strict)",
        _ref(task),
    )
    snapshots: list[Snapshot] = []
    for line in out.splitlines():
        # A ref name holds no NUL: four fields, always.
        ref, commit, parent, created = line.split("\0")
        snapshot_id = ref.rsplit("/", 1)[-1]
        if not valid_snapshot_id(snapshot_id) or not parent:
            continue
        snapshots.append(
            Snapshot(
                snapshot_id=snapshot_id,
                commit=commit,
                head=parent.split()[0],
                created_at=created,
                label=snapshot_id.split("-", 1)[1],
            )
        )
    return snapshots


def prune(worktree: Path, task: str, keep: int) -> int:
    """Delete the task's snapshots beyond the ``keep`` newest. Returns how many."""
    removed = 0
    for old in list_snapshots(worktree, task)[max(keep, 1) :]:
        _git(worktree, "update-ref", "-d", _ref(task, old.snapshot_id))
        removed += 1
    return removed


def create_snapshot(
    worktree: Path, task: str, label: str = "session", keep: int = 10
) -> Snapshot:
    """Snapshot the worktree as it is; the newest one again when nothing changed."""
    if not valid_task_name(task):
        raise SnapshotError("invalid task name")
    if not _LABEL.match(label):
        raise SnapshotError("invalid snapshot label")
    head = _git(worktree, "rev-parse", "--verify", "HEAD")
    with _ScratchIndex(worktree) as index:
        env = _env(index)
        _git(worktree, "add", "-A", env=env, timeout=300)
        # Tracked or not, the build's own state stays out of the snapshot.
        _git(
            worktree,
            "rm",
            "-r",
            "-q",
            "--cached",
            "--ignore-unmatch",
            "--",
            ".workpilot",
            env=env,
        )
        tree = _git(worktree, "write-tree", env=env)

    existing = list_snapshots(worktree, task)
    if existing:
        latest = existing[0]
        same_tree = _git(worktree, "rev-parse", f"{latest.commit}^{{tree}}") == tree
        if same_tree and latest.head == head:
            return latest

    snapshot_id = _new_id(label)
    commit = _git(
        worktree,
        "commit-tree",
        "--no-gpg-sign",
        tree,
        "-p",
        head,
        "-m",
        f"WorkPilot snapshot of {task} ({label})",
        env=_env(),
    )
    _git(worktree, "update-ref", _ref(task, snapshot_id), commit)
    if keep > 0:
        prune(worktree, task, keep)
    return Snapshot(
        snapshot_id=snapshot_id,
        commit=commit,
        head=head,
        created_at=datetime.now(UTC).isoformat(),
        label=label,
    )


def rollback(worktree: Path, task: str, snapshot_id: str) -> dict[str, str]:
    """Put the worktree back as it was at ``snapshot_id``.

    Returns the snapshot restored and the one taken of the state replaced.
    """
    if not valid_snapshot_id(snapshot_id):
        raise SnapshotError("invalid snapshot id")
    target = next(
        (s for s in list_snapshots(worktree, task) if s.snapshot_id == snapshot_id),
        None,
    )
    if target is None:
        raise SnapshotError("no such snapshot")
    # The state about to be replaced, kept so this rollback can be undone.
    # Not pruned now: the target may be the oldest one kept.
    before = create_snapshot(worktree, task, "before_rollback", keep=0)

    _git(worktree, "reset", "--quiet", "--hard", target.head, timeout=300)
    _git(worktree, "clean", "-f", "-d", "-q", "-e", ".workpilot", timeout=300)
    with _ScratchIndex(worktree) as index:
        env = _env(index)
        _git(worktree, "read-tree", f"{target.commit}^{{tree}}", env=env)
        _git(worktree, "checkout-index", "-a", "-f", env=env, timeout=300)
    return {"restored": target.snapshot_id, "safety": before.snapshot_id}


__all__ = [
    "NAMESPACE",
    "Snapshot",
    "SnapshotError",
    "create_snapshot",
    "list_snapshots",
    "prune",
    "rollback",
    "task_worktree",
    "valid_snapshot_id",
    "valid_task_name",
    "worktree_of",
]
