"""The runs a server restart interrupted, as the person is offered them.

``GET /users/me/interrupted-runs``: the runs of the projects the caller sees
in the organization they act in (``visible_projects``) that a restart
interrupted and nobody answered yet — their own, and every one of a project
they own (``server/services/interrupted_runs.py``).
``POST /users/me/interrupted-runs/later``: « Later », those runs are no longer
offered. Resuming one is ``POST /projects/{project_id}/specs/{spec_id}/runs/
{run_id}/resume`` (``server/routers/specs.py``), with the permission starting
a run takes.

Both need ``task.read``: reading where a card's work stopped, and setting an
offer aside, start nothing.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from server.auth.deps import CurrentUser, get_current_user
from server.authz.deps import require_permission
from server.authz.principal import get_principal
from server.db.engine import get_db
from server.routers.projects import visible_projects
from server.services import interrupted_runs
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users/me/interrupted-runs", tags=["users"])

_READ = [Depends(require_permission("task.read"))]

RunId = Annotated[str, Field(min_length=1, max_length=64)]


class SetAside(BaseModel):
    run_ids: list[RunId] = Field(max_length=interrupted_runs.MAX_OFFERED)


async def _roles(request: Request, db: AsyncSession) -> dict[str, str | None]:
    return {
        project.id: role
        for project, role in await visible_projects(db, get_principal(request))
    }


@router.get("", dependencies=_READ)
async def my_interrupted_runs(
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    rows = await interrupted_runs.offered_runs(db, user.id, await _roles(request, db))
    return {"runs": await interrupted_runs.describe(db, user.id, rows)}


@router.post("/later", dependencies=_READ)
async def set_my_interrupted_runs_aside(
    body: SetAside,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    done = await interrupted_runs.set_aside(
        db, user.id, await _roles(request, db), body.run_ids
    )
    return {"set_aside": done}
