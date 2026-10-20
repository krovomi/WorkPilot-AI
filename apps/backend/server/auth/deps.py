"""FastAPI dependencies for authentication and authorization."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from server.auth.jwt_tokens import TokenError, decode_access_token
from server.db.engine import get_db
from server.db.models import GlobalRole, Project, ProjectMember, ProjectRole
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class CurrentUser:
    """Authenticated principal, built from access-token claims only
    (no DB hit on the hot path)."""

    id: str
    email: str
    display_name: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == GlobalRole.ADMIN.value


def _extract_bearer_token(request: Request) -> str:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing bearer token")
    return auth[len("Bearer ") :].strip()


async def get_current_user(request: Request) -> CurrentUser:
    token = _extract_bearer_token(request)
    try:
        claims = decode_access_token(token)
    except TokenError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return CurrentUser(
        id=claims["sub"],
        email=claims.get("email", ""),
        display_name=claims.get("name", ""),
        role=claims.get("role", GlobalRole.MEMBER.value),
    )


async def require_admin(
    user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin role required")
    return user


# Project-role hierarchy for membership checks.
_PROJECT_ROLE_RANK = {
    ProjectRole.VIEWER.value: 0,
    ProjectRole.MEMBER.value: 1,
    ProjectRole.OWNER.value: 2,
}


async def get_project_role(
    db: AsyncSession, user: CurrentUser, project_id: str, org_id: str | None = None
) -> str | None:
    """The user's role on a project. Platform admins are implicit owners.

    ``org_id`` is the tenant the caller is acting in. When given, a project
    belonging to any other tenant resolves to ``None`` — no role at all —
    whatever membership rows happen to exist. That check lives here rather than
    in each route so a route cannot forget it.
    """
    if org_id is not None and not user.is_admin:
        owner_org = await db.scalar(
            select(Project.org_id).where(Project.id == project_id)
        )
        if owner_org is not None and owner_org != org_id:
            return None

    if user.is_admin:
        return ProjectRole.OWNER.value
    return await db.scalar(
        select(ProjectMember.role).where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user.id,
        )
    )


def require_project_role(minimum: str = ProjectRole.VIEWER.value):
    """Dependency factory: the route must have a ``project_id`` path param.

    Usage::

        @router.get("/projects/{project_id}/specs")
        async def list_specs(
            project_id: str,
            member=Depends(require_project_role("viewer")),
        ): ...
    """

    async def _check(
        project_id: str,
        request: Request,
        user: CurrentUser = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> CurrentUser:
        role = await get_project_role(
            db, user, project_id, org_id=getattr(request.state, "org_id", None)
        )
        if role is None:
            raise HTTPException(status_code=403, detail="Not a member of this project")
        if _PROJECT_ROLE_RANK.get(role, -1) < _PROJECT_ROLE_RANK[minimum]:
            raise HTTPException(
                status_code=403, detail=f"Requires project role '{minimum}' or higher"
            )
        return user

    return _check
