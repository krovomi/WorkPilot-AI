"""``--steer "<text>"``: send a message to a task while it runs.

The message joins the task's steering queue (`foundation.steering`) in both
copies of the spec, the project's and the worktree's, and reaches the prompt
of the next session it applies to. ``--steer-subtask`` aims it at one subtask.
"""

from __future__ import annotations

from pathlib import Path

from foundation.steering import add_message, load_messages
from ui import print_status


def _worktree_spec_dir(project_dir: Path, spec_name: str) -> Path | None:
    for base in (
        project_dir / ".workpilot" / "worktrees" / "tasks",
        project_dir / ".worktrees",
    ):
        candidate = base / spec_name / ".workpilot" / "specs" / spec_name
        if candidate.is_dir():
            return candidate
    return None


def handle_steer_command(
    project_dir: Path, spec_dir: Path, text: str, subtask_id: str | None = None
) -> bool:
    """Queue ``text`` for the task; whether it was queued."""
    worktree_spec = _worktree_spec_dir(project_dir, spec_dir.name)
    try:
        add_message(
            text, spec_dir, worktree_spec, source="cli", target_subtask_id=subtask_id
        )
    except (ValueError, OSError) as exc:
        print_status(f"Message not sent: {exc}", "error")
        return False
    waiting = sum(1 for m in load_messages(spec_dir, worktree_spec) if not m.delivered)
    target = f" for subtask {subtask_id}" if subtask_id else ""
    print_status(
        f"Message queued{target}: the next session receives it "
        f"({waiting} message(s) waiting).",
        "success",
    )
    return True
