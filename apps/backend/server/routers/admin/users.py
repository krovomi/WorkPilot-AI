"""User administration: activation, platform role, and live sessions."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from server.auth.deps import CurrentUser
from server.auth.jwt_tokens import revoke_all_sessions
from server.authz.deps import require_org, require_permission, require_platform_admin
from server.db.engine import get_db
from server.db.models import AuthSession, GlobalRole, OrgMember, User
from server.schemas import SessionPublic, UserPublic
from server.services.audit import record
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin:users"])


@router.get("/users", response_model=list[UserPublic])
async def list_org_users(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("org.member.read")),
    db: AsyncSession = Depends(get_db),
) -> list[UserPublic]:
    """Users of the organization the caller is acting in.

    Deliberately narrower than ``GET /users``, which is the directory any
    authenticated user may read to fill a member picker. This one is scoped to
    the tenant and gated, because it is what the administration console lists.
    """
    users = await db.scalars(
        select(User)
        .join(OrgMember, OrgMember.user_id == User.id)
        .where(OrgMember.org_id == org_id)
        .order_by(User.display_name)
    )
    return [UserPublic.model_validate(u) for u in users]


@router.post("/users/{user_id}/deactivate", response_model=UserPublic)
async def deactivate_user(
    user_id: str,
    request: Request,
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    org_id: str = Depends(require_org),
    db: AsyncSession = Depends(get_db),
) -> UserPublic:
    """Disable an account and cut every live session immediately.

    Deactivation without revocation would leave the user working for up to the
    access token's lifetime, which is exactly the window that matters when
    somebody is being locked out.
    """
    if user_id == actor.id:
        raise HTTPException(status_code=400, detail="You cannot deactivate yourself")

    user = await _member_of(db, org_id, user_id)
    user.is_active = False
    revoked = await revoke_all_sessions(db, user_id, commit=False)

    await record(
        db,
        action="user.deactivated",
        actor_id=actor.id,
        org_id=org_id,
        payload={"user_id": user_id, "sessions_revoked": revoked},
        request=request,
    )
    await db.commit()
    return UserPublic.model_validate(user)


@router.post("/users/{user_id}/activate", response_model=UserPublic)
async def activate_user(
    user_id: str,
    request: Request,
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    org_id: str = Depends(require_org),
    db: AsyncSession = Depends(get_db),
) -> UserPublic:
    user = await _member_of(db, org_id, user_id)
    user.is_active = True
    await record(
        db,
        action="user.activated",
        actor_id=actor.id,
        org_id=org_id,
        payload={"user_id": user_id},
        request=request,
    )
    await db.commit()
    return UserPublic.model_validate(user)


@router.post("/users/{user_id}/platform-role", response_model=UserPublic)
async def set_platform_role(
    user_id: str,
    request: Request,
    role: str,
    actor: CurrentUser = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_db),
) -> UserPublic:
    """Grant or revoke deployment-wide administration.

    Platform admin reaches into every tenant, so it is never grantable from
    inside one: only an existing platform admin can hand it out.
    """
    valid = {r.value for r in GlobalRole}
    if role not in valid:
        raise HTTPException(
            status_code=400, detail=f"role must be one of {sorted(valid)}"
        )
    if user_id == actor.id and role != GlobalRole.ADMIN.value:
        # Otherwise the last administrator can lock the deployment's own
        # administration out of itself.
        raise HTTPException(
            status_code=400, detail="You cannot drop your own platform-admin role"
        )

    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    before = user.role
    user.role = role
    await record(
        db,
        action="user.platform_role_changed",
        actor_id=actor.id,
        payload={"user_id": user_id, "before": before, "after": role},
        request=request,
    )
    await db.commit()
    return UserPublic.model_validate(user)


@router.get("/sessions", response_model=list[SessionPublic])
async def list_sessions(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("org.session.read")),
    db: AsyncSession = Depends(get_db),
    user_id: str | None = None,
) -> list[SessionPublic]:
    """Live refresh sessions of this organization's members."""
    query = (
        select(AuthSession, User)
        .join(User, User.id == AuthSession.user_id)
        .join(OrgMember, OrgMember.user_id == User.id)
        .where(OrgMember.org_id == org_id, AuthSession.revoked_at.is_(None))
        .order_by(AuthSession.created_at.desc())
    )
    if user_id:
        query = query.where(AuthSession.user_id == user_id)

    return [
        SessionPublic(
            id=session.id,
            user_id=session.user_id,
            user_email=user.email,
            user_agent=session.user_agent,
            ip=session.ip,
            created_at=session.created_at,
            expires_at=session.expires_at,
        )
        for session, user in (await db.execute(query)).all()
    ]


@router.delete("/sessions/{user_id}")
async def revoke_user_sessions(
    user_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.session.revoke")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Force a user out of every device now."""
    await _member_of(db, org_id, user_id)
    revoked = await revoke_all_sessions(db, user_id, commit=False)
    await record(
        db,
        action="user.sessions_revoked",
        actor_id=actor.id,
        org_id=org_id,
        payload={"user_id": user_id, "count": revoked},
        request=request,
    )
    await db.commit()
    return {"revoked": revoked}


async def _member_of(db: AsyncSession, org_id: str, user_id: str) -> User:
    """The user, if they belong to this organization. 404 otherwise.

    Scoped so an administrator of one tenant cannot act on a user of another
    just by knowing their id.
    """
    user = await db.scalar(
        select(User)
        .join(OrgMember, OrgMember.user_id == User.id)
        .where(OrgMember.org_id == org_id, User.id == user_id)
    )
    if user is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    return user
