"""Manual checks and the subtasks a person sent back, in the coder loop.

Three moments of the loop, out of ``coder.py`` and ``session.py``:

- before a session, ``take_human_unblock`` sees that a person answered a
  blocked subtask from the panel (``unblocked_at``, written by
  ``foundation.subtask_unblock.apply_unblock``) and starts its attempt count
  over, so the recovery manager does not give up on the first new failure;
- ``skip_manual_verification`` keeps skipping a subtask whose verification is
  ``manual`` (no session can run it), except one a person sent back: that one
  runs, with the person's reply in its prompt;
- after a session, ``settle_block`` writes the reason of a block where the app
  reads it, and never turns a subtask the agent completed into a block.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from foundation.subtask_unblock import block, normalize_block

from .utils import find_subtask_in_plan, load_implementation_plan

logger = logging.getLogger(__name__)

MANUAL_NO_CHANGE_REASON = (
    "This subtask asks for a manual check and the agent made no change: "
    "check it yourself, then mark it done, or send it back to the agent."
)


def _save(spec_dir: Path, plan: dict[str, Any]) -> bool:
    from qa.criteria import save_implementation_plan

    # save_implementation_plan reports a write failure instead of raising:
    # the loop goes on and the plan on disk stays as it was.
    saved = save_implementation_plan(spec_dir, plan)
    if not saved:
        logger.error("Could not save the implementation plan in %s", spec_dir)
    return saved


def sent_back_by_person(subtask: dict[str, Any]) -> bool:
    """A person answered this subtask from the panel (retry or reply)."""
    return bool(subtask.get("unblocked_at") or subtask.get("human_reply"))


def take_human_unblock(spec_dir: Path, subtask_id: str, recovery_manager) -> bool:
    """Start the attempt count over for a subtask a person just sent back.

    Returns True the first time it sees a given ``unblocked_at``; the stamp it
    saw is kept as ``unblock_seen_at`` so a later retry of the same session
    keeps counting.
    """
    plan = load_implementation_plan(spec_dir)
    subtask = find_subtask_in_plan(plan, subtask_id) if plan else None
    if not subtask:
        return False
    stamp = subtask.get("unblocked_at")
    if not stamp or subtask.get("unblock_seen_at") == stamp:
        return False
    recovery_manager.reset_subtask(subtask_id)
    subtask["unblock_seen_at"] = stamp
    _save(spec_dir, plan)
    return True


def skip_manual_verification(
    spec_dir: Path, subtask_id: str, next_subtask: dict[str, Any], task_logger
) -> bool:
    """Mark a ``manual`` verification subtask completed without a session.

    No session can run a manual check, and waiting on one froze the build; it
    is completed with ``_manual_review_required`` for the human review. A
    subtask a person sent back is the exception (returns False): the person
    asked the agent to work on it.
    """
    verification = next_subtask.get("verification") or {}
    if verification.get("type") != "manual" or sent_back_by_person(next_subtask):
        return False
    from task_logger import LogEntryType, LogPhase
    from ui import print_status

    print_status(f"Subtask {subtask_id} requires manual verification", "warning")
    plan = load_implementation_plan(spec_dir)
    subtask = find_subtask_in_plan(plan, subtask_id) if plan else None
    if subtask:
        subtask["status"] = "completed"
        subtask["_manual_review_required"] = True
        if _save(spec_dir, plan):
            print_status(
                f"✓ Subtask {subtask_id} marked as COMPLETED (manual review needed)",
                "warning",
            )
            if task_logger:
                task_logger.log(
                    f"Subtask {subtask_id}: Manual verification task - marked completed for human review",
                    LogEntryType.TEXT,
                    LogPhase.CODING,
                )
    return True


def settle_block(
    spec_dir: Path, plan: dict[str, Any], subtask: dict[str, Any], new_commits: int
) -> str:
    """The subtask's status after a session, its block explained.

    A manual check that left the subtask open with no commit is blocked with
    a reason the panel shows; one the agent completed stays completed (the
    check itself needs no commit). An agent's own block gets its reason moved
    to ``blocked_reason``. Returns the status to report.
    """
    status = subtask.get("status", "pending")
    is_manual = (subtask.get("verification") or {}).get("type") == "manual"
    changed = False
    if is_manual and new_commits == 0 and status not in ("completed", "blocked"):
        block(subtask, MANUAL_NO_CHANGE_REASON, "manual_verification")
        changed = True
    changed = normalize_block(subtask) or changed
    if changed:
        _save(spec_dir, plan)
    return subtask.get("status", status)
