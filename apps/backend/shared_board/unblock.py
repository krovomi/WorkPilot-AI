"""Server mode: answer a blocked subtask of a card from the app.

The subtask panel offers four answers to a blocked (or failed) subtask: it is
done, it is not needed, try again, try again with this reply. On a server
project the plans are the server's (the card's folder and its build
workspace), so this route writes them there, by ``project_id``; the app then
starts a ``build`` run for the two answers that send the subtask back to the
agent. The rules of each answer are ``foundation.subtask_unblock``'s, the same
the desktop app applies to a local task.

Mounted on the board's router by ``shared_board.api``
(``POST /api/board/cards/{id}/subtasks/{subtask}/unblock``).
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Literal

from fastapi import Depends, HTTPException, Request
from foundation.subtask_unblock import MAX_REPLY, RESTART_ACTIONS, apply_unblock
from pydantic import BaseModel, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.services.events import emit_board_event
from shared_board.cards import _card_or_404, _index_row, _require_writer
from shared_board.review import _SPECS, _within, _workspace
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

# A subtask id as planners write them (``subtask-1-2``, ``change-request-…``).
SUBTASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PLAN = "implementation_plan.json"
_STATUS_BY_ERROR = {
    "subtask_not_found": 404,
    "not_blocked": 409,
}


class UnblockRequest(BaseModel):
    action: Literal["complete", "skip", "retry", "answer"]
    reply: str = Field(default="", max_length=MAX_REPLY)


def _plans(scope: ProjectScope, card_id: str, directory: Path) -> list[Path]:
    """The card's plan, then its workspace copy when the build made one."""
    plans = [directory / _PLAN]
    workspace = _workspace(scope, card_id)
    if workspace is not None:
        spec = _within(workspace, str(_SPECS), card_id, _PLAN)
        if spec is not None:
            plans.append(spec)
    return [plan for plan in plans if plan.is_file()]


def _apply(plan_path: Path, subtask_id: str, body: UnblockRequest) -> dict[str, Any]:
    try:
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=409, detail="Plan unreadable") from exc
    if not isinstance(plan, dict):
        raise HTTPException(status_code=409, detail="Plan unreadable")
    try:
        subtask = apply_unblock(plan, subtask_id, body.action, body.reply)
    except ValueError as exc:
        code = str(exc)
        raise HTTPException(
            status_code=_STATUS_BY_ERROR.get(code, 422), detail=code
        ) from exc
    plan_path.write_text(json.dumps(plan, indent=2), encoding="utf-8")
    return subtask


async def unblock_subtask(
    card_id: str,
    subtask_id: str,
    body: UnblockRequest,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Apply a person's answer to a blocked subtask of the card.

    ``restart`` in the answer tells the app to start a ``build`` run. The reply
    is the person's text, written to the plan, never to argv.
    """
    from server.services.run_manager import get_run_manager

    principal = get_principal(request)
    _require_writer(scope, principal)
    if not SUBTASK_ID.match(subtask_id):
        raise HTTPException(status_code=404, detail="subtask_not_found")
    directory = _card_or_404(scope, card_id)
    plans = _plans(scope, card_id, directory)
    if not plans:
        raise HTTPException(status_code=404, detail="subtask_not_found")
    if body.action in RESTART_ACTIONS:
        row = await _index_row(db, scope, card_id)
        if row is not None and get_run_manager().is_running(row.id):
            raise HTTPException(status_code=409, detail="task_running")

    # The card's own plan decides (the app shows it); the workspace copy
    # follows it, and may not hold the subtask yet.
    subtask = _apply(plans[0], subtask_id, body)
    for copy in plans[1:]:
        try:
            _apply(copy, subtask_id, body)
        except HTTPException as exc:
            # A workspace made before the subtask was added does not hold it:
            # the card's plan has the answer, the build copies it at start.
            logger.info("Workspace plan of %s left as it was: %s", card_id, exc.detail)
    emit_board_event(
        scope.project_id, "spec_updated", {"spec": card_id, "by": principal.id}
    )
    return {"subtask": subtask, "restart": body.action in RESTART_ACTIONS}
