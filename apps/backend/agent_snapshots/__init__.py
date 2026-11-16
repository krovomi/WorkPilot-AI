"""Git snapshots of a task's worktree before each agent session, and the rollback.

See ``store`` for how a snapshot is built and restored. Imports only
``foundation``.
"""

from .store import (
    NAMESPACE,
    Snapshot,
    SnapshotError,
    create_snapshot,
    list_snapshots,
    prune,
    rollback,
    task_worktree,
    valid_snapshot_id,
    valid_task_name,
    worktree_of,
)

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
