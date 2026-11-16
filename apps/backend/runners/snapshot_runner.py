"""
Snapshot runner — the snapshots of one task's worktree, for the app.

Spawned by the Electron main process (``main/ipc-handlers/task/snapshot-handlers.ts``)
when the person opens a task's snapshots or restores one. The main process has
already checked that the task belongs to a registered project and that no
agent is running on it; the task name and the snapshot id are checked again
here, and the worktree is the task's own (``agent_snapshots.worktree_of``),
never the project's main checkout.

One JSON object on stdout:

  {"snapshots": [{...Snapshot.to_dict()...}, ...]}      (list)
  {"restored": "<id>", "safety": "<id>"}                 (rollback)
  {"error": "..."}

Usage::

    python snapshot_runner.py list --project-dir <root> --task <name>
    python snapshot_runner.py rollback --project-dir <root> --task <name> --snapshot <id>
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent
sys.path.insert(0, str(backend_path))

from agent_snapshots import (  # noqa: E402
    SnapshotError,
    list_snapshots,
    rollback,
    worktree_of,
)


def run(argv: list[str]) -> dict:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("list", "rollback"))
    parser.add_argument("--project-dir", required=True)
    parser.add_argument("--task", required=True)
    parser.add_argument("--snapshot")
    args = parser.parse_args(argv)
    try:
        worktree = worktree_of(Path(args.project_dir), args.task)
        if args.command == "list":
            return {
                "snapshots": [s.to_dict() for s in list_snapshots(worktree, args.task)]
            }
        if not args.snapshot:
            return {"error": "--snapshot is required"}
        return rollback(worktree, args.task, args.snapshot)
    except SnapshotError as exc:
        return {"error": str(exc)}
    except OSError as exc:
        return {"error": f"cannot read the worktree: {exc.strerror or exc}"}


def main(argv: list[str] | None = None) -> int:
    result = run(sys.argv[1:] if argv is None else argv)
    print(json.dumps(result), flush=True)
    return 1 if "error" in result else 0


if __name__ == "__main__":
    from foundation.log_redaction import install_global_redaction

    install_global_redaction()
    sys.exit(main())
