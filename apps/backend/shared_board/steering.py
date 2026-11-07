"""Server mode: send a message to a card's task while it runs, and read the queue.

The steering queue (`foundation.steering`) lives in the card's folder and in
its build workspace's copy of the spec: the build reads the workspace's, a
new build copies the card's over it. The app (desktop or phone) passes a
``project_id``, never a path; sending needs ``agent.execute``
(`server.authz.mounting.ROUTE_OVERRIDES`), since it changes what the agent
does, and the board's writer role. Reading needs the board's read.

Mounted on the board's router by ``shared_board.api``
(``GET`` and ``POST /api/board/cards/{id}/steering``).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fastapi import Depends, HTTPException, Request
from foundation.steering import MAX_STEERING_CHARS, add_message, load_messages
from pydantic import BaseModel, Field
from server.authz.principal import get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.services.events import emit_board_event
from shared_board.cards import _card_or_404, _require_writer
from shared_board.review import _SPECS, _within, _workspace

_SUBTASK_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


class SteeringRequest(BaseModel):
    text: str = Field(min_length=1, max_length=MAX_STEERING_CHARS)
    target_subtask_id: str | None = Field(default=None, max_length=128)
    # A phone says it is one; anything else is the server's own app.
    source: str = Field(default="server", pattern="^(server|mobile)$")


def _copies(scope: ProjectScope, card_id: str, directory: Path) -> list[Path]:
    copies = [directory]
    workspace = _workspace(scope, card_id)
    if workspace is not None:
        spec = _within(workspace, str(_SPECS), card_id)
        if spec is not None and spec.is_dir():
            copies.append(spec)
    return copies


def _listing(copies: list[Path]) -> dict[str, Any]:
    return {"messages": [m.as_dict() for m in load_messages(*copies)]}


async def card_steering(
    card_id: str,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The card's messages, oldest first, each with its delivery when it has one."""
    directory = _card_or_404(scope, card_id)
    return _listing(_copies(scope, card_id, directory))


async def steer_card(
    card_id: str,
    body: SteeringRequest,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Queue the person's message for the next session of the card's task."""
    principal = get_principal(request)
    _require_writer(scope, principal)
    target = body.target_subtask_id or None
    if target is not None and not _SUBTASK_ID.match(target):
        raise HTTPException(status_code=422, detail="invalid_subtask")
    directory = _card_or_404(scope, card_id)
    copies = _copies(scope, card_id, directory)
    try:
        add_message(body.text, *copies, source=body.source, target_subtask_id=target)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail="queue_unwritable") from exc
    emit_board_event(
        scope.project_id, "spec_updated", {"spec": card_id, "by": principal.id}
    )
    return _listing(copies)
