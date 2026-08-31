"""Organizations (tenants) and their membership."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from server.auth.deps import CurrentUser
from server.authz.deps import require_org, require_permission, require_platform_admin
from server.authz.roles import DEFAULT_ORG_ROLE
from server.db.engine import get_db
from server.db.models import Organization, OrgMember, Role, User
from server.schemas import (
    AddOrgMemberRequest,
    CreateOrganizationRequest,
    OrganizationPublic,
    OrgMemberPublic,
    UpdateOrganizationRequest,
    UpdateOrgMemberRequest,
)
from server.services.audit import record
from server.services.quotas import enforce_seat_quota
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin:orgs"])


# ---------------------------------------------------------------------------
# Tenants — platform administration
# ---------------------------------------------------------------------------


@router.get("/orgs", response_model=list[OrganizationPublic])
async def list_orgs(
    _: CurrentUser = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_db),
) -> list[OrganizationPublic]:
    """Every tenant on the deployment. Platform administrators only."""
    orgs = await db.scalars(select(Organization).order_by(Organization.created_at))
    return [OrganizationPublic.model_validate(o) for o in orgs]


@router.post("/orgs", response_model=OrganizationPublic, status_code=201)
async def create_org(
    body: CreateOrganizationRequest,
    request: Request,
    user: CurrentUser = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_db),
) -> OrganizationPublic:
    clash = await db.scalar(
        select(Organization.id).where(Organization.slug == body.slug)
    )
    if clash:
        raise HTTPException(
            status_code=409, detail=f"An organization with slug '{body.slug}' exists"
        )

    org = Organization(name=body.name, slug=body.slug, is_active=True)
    db.add(org)
    await record(
        db,
        action="org.created",
        actor_id=user.id,
        org_id=org.id,
        payload={"name": body.name, "slug": body.slug},
        request=request,
    )
    await db.commit()
    return OrganizationPublic.model_validate(org)


@router.patch("/orgs/{target_org_id}", response_model=OrganizationPublic)
async def update_org(
    target_org_id: str,
    body: UpdateOrganizationRequest,
    request: Request,
    user: CurrentUser = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_db),
) -> OrganizationPublic:
    org = await db.get(Organization, target_org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    if body.name is not None:
        org.name = body.name
    if body.is_active is not None:
        org.is_active = body.is_active
    if body.disabled_permissions is not None:
        # Not validated against the catalog on purpose: an org configured
        # against a newer build must not break when rolled back. Unknown keys
        # are simply inert (see server.authz.engine).
        settings = dict(org.settings or {})
        settings["disabled_permissions"] = sorted(set(body.disabled_permissions))
        org.settings = settings

    await record(
        db,
        action="org.updated",
        actor_id=user.id,
        org_id=org.id,
        payload={"is_active": org.is_active, "settings": org.settings},
        request=request,
    )
    await db.commit()
    return OrganizationPublic.model_validate(org)


@router.delete("/orgs/{target_org_id}")
async def delete_org(
    target_org_id: str,
    request: Request,
    user: CurrentUser = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete a tenant and, by cascade, its projects, specs and memberships.

    Irreversible, so it is a platform-admin action and never an org-admin one:
    nobody should be able to erase their own tenant's audit history.
    """
    org = await db.get(Organization, target_org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")

    slug = org.slug
    await db.delete(org)
    await record(
        db,
        action="org.deleted",
        actor_id=user.id,
        org_id=target_org_id,
        payload={"slug": slug},
        request=request,
    )
    await db.commit()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Members of the organization the caller is acting in
# ---------------------------------------------------------------------------


async def _role_in_scope(db: AsyncSession, org_id: str, slug: str) -> Role:
    role = await db.scalar(
        select(Role).where(
            Role.slug == slug, or_(Role.org_id.is_(None), Role.org_id == org_id)
        )
    )
    if role is None:
        raise HTTPException(status_code=400, detail=f"Unknown role '{slug}'")
    return role


@router.get("/members", response_model=list[OrgMemberPublic])
async def list_members(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("org.member.read")),
    db: AsyncSession = Depends(get_db),
) -> list[OrgMemberPublic]:
    rows = await db.execute(
        select(OrgMember, User, Role)
        .join(User, User.id == OrgMember.user_id)
        .join(Role, Role.id == OrgMember.role_id)
        .where(OrgMember.org_id == org_id)
        .order_by(User.display_name)
    )
    return [
        OrgMemberPublic(
            user_id=user.id,
            email=user.email,
            display_name=user.display_name,
            avatar_url=user.avatar_url,
            role_id=role.id,
            role_slug=role.slug,
            role_name=role.name,
            is_active=user.is_active,
            created_at=member.created_at,
        )
        for member, user, role in rows.all()
    ]


@router.post("/members", response_model=OrgMemberPublic, status_code=201)
async def add_member(
    body: AddOrgMemberRequest,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> OrgMemberPublic:
    user = await db.get(User, body.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    existing = await db.scalar(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id, OrgMember.user_id == body.user_id
        )
    )
    if existing:
        raise HTTPException(status_code=409, detail="Already a member")

    await enforce_seat_quota(db, org_id)
    role = await _role_in_scope(db, org_id, body.role_slug or DEFAULT_ORG_ROLE)

    member = OrgMember(org_id=org_id, user_id=user.id, role_id=role.id)
    db.add(member)
    await record(
        db,
        action="org.member.added",
        actor_id=actor.id,
        org_id=org_id,
        payload={"user_id": user.id, "role": role.slug},
        request=request,
    )
    await db.commit()
    return OrgMemberPublic(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        role_id=role.id,
        role_slug=role.slug,
        role_name=role.name,
        is_active=user.is_active,
        created_at=member.created_at,
    )


@router.patch("/members/{member_user_id}", response_model=OrgMemberPublic)
async def update_member_role(
    member_user_id: str,
    body: UpdateOrgMemberRequest,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> OrgMemberPublic:
    member = await db.scalar(
        select(OrgMember).where(
            OrgMember.org_id == org_id, OrgMember.user_id == member_user_id
        )
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")

    role = await _role_in_scope(db, org_id, body.role_slug)
    previous = member.role_id
    member.role_id = role.id

    await record(
        db,
        action="org.member.role_changed",
        actor_id=actor.id,
        org_id=org_id,
        payload={
            "user_id": member_user_id,
            "role_before": previous,
            "role_after": role.slug,
        },
        request=request,
    )
    await db.commit()

    user = await db.get(User, member_user_id)
    return OrgMemberPublic(
        user_id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        role_id=role.id,
        role_slug=role.slug,
        role_name=role.name,
        is_active=user.is_active,
        created_at=member.created_at,
    )


@router.delete("/members/{member_user_id}")
async def remove_member(
    member_user_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    member = await db.scalar(
        select(OrgMember).where(
            OrgMember.org_id == org_id, OrgMember.user_id == member_user_id
        )
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")

    if member_user_id == actor.id:
        # Removing yourself from the org you administer is how a tenant ends up
        # with no administrator at all.
        raise HTTPException(
            status_code=400,
            detail="You cannot remove yourself from the organization you administer",
        )

    await db.delete(member)
    await record(
        db,
        action="org.member.removed",
        actor_id=actor.id,
        org_id=org_id,
        payload={"user_id": member_user_id},
        request=request,
    )
    await db.commit()
    return {"removed": True}
