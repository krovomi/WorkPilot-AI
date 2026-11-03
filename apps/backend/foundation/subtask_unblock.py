"""A blocked subtask: why the agent stopped, and how a person unblocks it.

A subtask the agent cannot finish is set to ``blocked`` in
``implementation_plan.json`` and the build moves on. The person then needs two
things from the subtask panel: the reason, in words they can act on, and a way
to answer. This module holds both halves, for every provider and every stack:

- ``block`` writes the reason where the app reads it (``blocked_reason``) with
  a ``blocked_kind`` from a closed list, so the panel can say what to do;
- ``apply_unblock`` applies the person's answer to the plan: it is done
  (``complete``), it is not needed (``skip``), try again (``retry``) or try
  again with what I tell you (``answer``).

The desktop app writes the same fields for a local task
(``apps/frontend/src/main/ipc-handlers/task/subtask-unblock.ts``); the server
route of a shared card calls ``apply_unblock`` (``shared_board/unblock.py``).
The coder reads ``unblocked_at`` and ``human_reply`` back
(``agents/manual_verification.py``, ``prompts_pkg/prompt_generator.py``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

#: Why a subtask is blocked. ``needs_human``: the agent says only a person can
#: do it; ``manual_verification``: a manual check ended with no change made;
#: ``max_attempts`` / ``file_validation`` / ``tool_concurrency``: the recovery
#: manager gave up; ``agent``: any other reason.
BLOCKED_KINDS = (
    "needs_human",
    "manual_verification",
    "max_attempts",
    "file_validation",
    "tool_concurrency",
    "agent",
)

#: What a person can answer from the subtask panel.
UNBLOCK_ACTIONS = ("complete", "skip", "retry", "answer")

#: Actions that send the subtask back to the agent (the build restarts).
RESTART_ACTIONS = frozenset({"retry", "answer"})

#: Statuses a person can unblock: blocked, and failed (same panel, same answers).
UNBLOCKABLE_STATUSES = frozenset({"blocked", "failed"})

#: Longest reply kept for the agent, and longest reason kept for the panel.
MAX_REPLY = 4000
MAX_REASON = 1000

_BLOCK_FIELDS = ("blocked_reason", "_blocked_reason", "blocked_kind")


def _subtasks(plan: dict[str, Any]):
    for phase in plan.get("phases") or []:
        if not isinstance(phase, dict):
            continue
        for subtask in phase.get("subtasks", phase.get("chunks")) or []:
            if isinstance(subtask, dict):
                yield subtask


def find_subtask(plan: dict[str, Any], subtask_id: str) -> dict[str, Any] | None:
    """The subtask of ``plan`` with this id, or None."""
    for subtask in _subtasks(plan):
        if str(subtask.get("id")) == subtask_id:
            return subtask
    return None


def blocked_reason(subtask: dict[str, Any]) -> str:
    """The reason recorded for a block, ``""`` when there is none.

    Agents told by an older prompt wrote ``_blocked_reason``: it is read too.
    """
    for key in ("blocked_reason", "_blocked_reason"):
        value = subtask.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:MAX_REASON]
    return ""


def block(subtask: dict[str, Any], reason: str, kind: str = "agent") -> None:
    """Set ``subtask`` to blocked, with a reason and a kind the panel reads."""
    subtask["status"] = "blocked"
    subtask["blocked_reason"] = (reason or "").strip()[:MAX_REASON]
    subtask["blocked_kind"] = kind if kind in BLOCKED_KINDS else "agent"
    subtask.pop("_blocked_reason", None)


def normalize_block(subtask: dict[str, Any]) -> bool:
    """Move an agent's own block to the fields the app reads.

    An agent sets ``status: blocked`` itself, with ``_blocked_reason``, with
    ``blocked_reason`` or with nothing. Returns True when the subtask changed.
    """
    if subtask.get("status") != "blocked":
        return False
    if subtask.get("blocked_reason") and subtask.get("blocked_kind") in BLOCKED_KINDS:
        return False
    block(
        subtask, blocked_reason(subtask), subtask.get("blocked_kind") or "needs_human"
    )
    return True


def _now(now: str | None) -> str:
    return now or datetime.now(UTC).isoformat()


def apply_unblock(
    plan: dict[str, Any],
    subtask_id: str,
    action: str,
    reply: str | None = None,
    now: str | None = None,
) -> dict[str, Any]:
    """Apply a person's answer to a blocked (or failed) subtask of ``plan``.

    Returns the updated subtask. Raises ``ValueError`` with a stable code
    (``invalid_action``, ``reply_required``, ``reply_too_long``,
    ``subtask_not_found``, ``not_blocked``) when the answer cannot apply.
    """
    if action not in UNBLOCK_ACTIONS:
        raise ValueError("invalid_action")
    text = (reply or "").strip()
    if action == "answer" and not text:
        raise ValueError("reply_required")
    if len(text) > MAX_REPLY:
        raise ValueError("reply_too_long")
    subtask = find_subtask(plan, subtask_id)
    if subtask is None:
        raise ValueError("subtask_not_found")
    if subtask.get("status") not in UNBLOCKABLE_STATUSES:
        raise ValueError("not_blocked")

    stamp = _now(now)
    previous_reason = blocked_reason(subtask)
    for key in _BLOCK_FIELDS:
        subtask.pop(key, None)

    if action in ("complete", "skip"):
        subtask["status"] = "completed"
        subtask["human_resolution"] = {
            "action": action,
            "at": stamp,
            **({"reason": previous_reason} if previous_reason else {}),
        }
        return subtask

    # retry / answer: back to the agent. ``unblocked_at`` tells the coder a
    # person sent it back (its attempt count starts over, a manual check is
    # run instead of skipped); the plan reopens so QA checks the result again.
    subtask["status"] = "pending"
    subtask["unblocked_at"] = stamp
    subtask.pop("human_resolution", None)
    if action == "answer":
        subtask["human_reply"] = text
        subtask["human_reply_at"] = stamp
    reopen_plan(plan, stamp)
    return subtask


def reopen_plan(plan: dict[str, Any], now: str | None = None) -> None:
    """Mark the plan as running again, its QA sign-off to be done again."""
    plan["status"] = "in_progress"
    plan["planStatus"] = "in_progress"
    plan["updated_at"] = _now(now)
    signoff = plan.get("qa_signoff")
    if isinstance(signoff, dict):
        signoff["status"] = "pending"
