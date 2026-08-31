"""Turning a project id into a filesystem path the caller is entitled to.

The legacy API let a client send ``project_dir`` — an absolute path — and read
it. That was sound for a desktop app: the backend ran as the person who picked
the directory, so there was no boundary to cross. On a shared server the same
parameter is a cross-tenant read and write, and it is the single most dangerous
thing in the surface, because ``POST /api/slash-commands/run`` executes an agent
with file and network tools rooted at whatever it is given.

So the direction is inverted. The client names a *project*; the server decides
where that project lives. Three checks stand between the two, and all three
have to pass:

1. the project exists;
2. it belongs to the organization the caller is acting in;
3. the caller is a member of that project, or an admin of the organization.
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import Depends, HTTPException, Query, Request
from server.authz.principal import Principal, get_principal
from server.db.engine import get_db
from server.db.models import Project, ProjectMember
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


class ProjectScope:
    """A project the caller may act on, and its server-side checkout."""

    __slots__ = ("project_id", "org_id", "path", "project_role")

    def __init__(
        self, project_id: str, org_id: str, path: Path, project_role: str | None
    ) -> None:
        self.project_id = project_id
        self.org_id = org_id
        self.path = path
        self.project_role = project_role

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"ProjectScope(project_id={self.project_id!r}, org_id={self.org_id!r})"


async def load_project_scope(
    db: AsyncSession, principal: Principal, project_id: str
) -> ProjectScope:
    """Resolve and authorize `project_id` for `principal`. Raises 403/404."""
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")

    # A project in another tenant is reported as missing, not as forbidden: a
    # 403 would confirm the id exists, which is itself a cross-tenant leak.
    if not principal.is_platform_admin and project.org_id != principal.org_id:
        logger.info(
            "User %s tried to reach project %s of org %s while acting in org %s",
            principal.id,
            project_id,
            project.org_id,
            principal.org_id,
        )
        raise HTTPException(status_code=404, detail="Project not found")

    role = await db.scalar(
        select(ProjectMember.role).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == principal.id,
        )
    )
    if role is None and not (
        principal.is_platform_admin or principal.has("project.member.write")
    ):
        raise HTTPException(status_code=403, detail="Not a member of this project")

    return ProjectScope(
        project_id=project.id,
        org_id=project.org_id,
        path=Path(project.server_path),
        project_role=role,
    )


async def resolve_project_scope(
    request: Request,
    project_id: str = Query(..., description="Id of the project to act on"),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> ProjectScope:
    """Dependency: the authorized project scope for this request.

    The resolved path is also stashed on ``request.state`` so a legacy endpoint
    body can pick it up through :func:`project_path_from_request` without having
    its signature changed.
    """
    if principal.is_local:
        raise HTTPException(
            status_code=400,
            detail="project_id scoping is only meaningful in server mode",
        )
    scope = await load_project_scope(db, principal, project_id)
    request.state.project_scope = scope
    request.state.project_path = str(scope.path)
    return scope


def project_path_from_request(request: Request) -> str | None:
    """The checkout resolved for this request, if any.

    The shim a legacy endpoint uses instead of the ``project_dir`` it used to
    trust, so its body need not change.
    """
    return getattr(request.state, "project_path", None)
