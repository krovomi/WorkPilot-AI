"""The permission catalog, and the roles built from it."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from server.auth.deps import CurrentUser
from server.authz.catalog import catalog_payload, validate_keys
from server.authz.deps import require_org, require_permission
from server.authz.roles import ORG_SCOPE, PROJECT_SCOPE
from server.db.engine import get_db
from server.db.models import OrgMember, Role
from server.schemas import (
    CreateRoleRequest,
    PermissionPublic,
    RolePublic,
    UpdateRoleRequest,
)
from server.services.audit import record
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin:roles"])


@router.get("/permissions", response_model=list[PermissionPublic])
async def list_permissions(
    _: CurrentUser = Depends(require_permission("org.role.read")),
) -> list[PermissionPublic]:
    """The whole catalog, so the console can draw the role × permission matrix.

    Served from code rather than a table: the catalog *is* the code, and a
    second copy in the database could only drift from what actually gates.
    """
    return [PermissionPublic(**item) for item in catalog_payload()]


@router.get("/roles", response_model=list[RolePublic])
async def list_roles(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("org.role.read")),
    db: AsyncSession = Depends(get_db),
) -> list[RolePublic]:
    """Built-in roles (shared by every tenant) plus this org's custom ones."""
    roles = await db.scalars(
        select(Role)
        .where(or_(Role.org_id.is_(None), Role.org_id == org_id))
        .order_by(Role.is_system.desc(), Role.name)
    )
    return [RolePublic.model_validate(r) for r in roles]


@router.post("/roles", response_model=RolePublic, status_code=201)
async def create_role(
    body: CreateRoleRequest,
    request: Request,
    org_id: str = Depends(require_org),
    user: CurrentUser = Depends(require_permission("org.role.write")),
    db: AsyncSession = Depends(get_db),
) -> RolePublic:
    if body.scope not in (ORG_SCOPE, PROJECT_SCOPE):
        raise HTTPException(
            status_code=400, detail=f"scope must be '{ORG_SCOPE}' or '{PROJECT_SCOPE}'"
        )
    try:
        permissions = validate_keys(body.permissions)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    clash = await db.scalar(
        select(Role.id).where(
            or_(Role.org_id == org_id, Role.org_id.is_(None)),
            Role.slug == body.slug,
        )
    )
    if clash:
        raise HTTPException(
            status_code=409,
            detail=f"A role with slug '{body.slug}' already exists (or is built in)",
        )

    role = Role(
        org_id=org_id,
        slug=body.slug,
        name=body.name,
        description=body.description,
        is_system=False,
        scope=body.scope,
        permissions=permissions,
    )
    db.add(role)
    await record(
        db,
        action="role.created",
        actor_id=user.id,
        org_id=org_id,
        payload={"slug": body.slug, "permissions": permissions},
        request=request,
    )
    await db.commit()
    return RolePublic.model_validate(role)


async def _editable_role(db: AsyncSession, role_id: str, org_id: str) -> Role:
    role = await db.get(Role, role_id)
    if role is None or (role.org_id is not None and role.org_id != org_id):
        raise HTTPException(status_code=404, detail="Role not found")
    if role.is_system:
        raise HTTPException(
            status_code=403,
            detail=(
                "Built-in roles are read-only. Duplicate it into a custom role "
                "if you need different permissions."
            ),
        )
    return role


@router.patch("/roles/{role_id}", response_model=RolePublic)
async def update_role(
    role_id: str,
    body: UpdateRoleRequest,
    request: Request,
    org_id: str = Depends(require_org),
    user: CurrentUser = Depends(require_permission("org.role.write")),
    db: AsyncSession = Depends(get_db),
) -> RolePublic:
    role = await _editable_role(db, role_id, org_id)

    before = list(role.permissions or ())
    if body.name is not None:
        role.name = body.name
    if body.description is not None:
        role.description = body.description
    if body.permissions is not None:
        try:
            role.permissions = validate_keys(body.permissions)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    await record(
        db,
        action="role.updated",
        actor_id=user.id,
        org_id=org_id,
        payload={
            "slug": role.slug,
            "permissions_before": before,
            "permissions_after": list(role.permissions or ()),
        },
        request=request,
    )
    await db.commit()
    return RolePublic.model_validate(role)


@router.delete("/roles/{role_id}")
async def delete_role(
    role_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    user: CurrentUser = Depends(require_permission("org.role.write")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    role = await _editable_role(db, role_id, org_id)

    in_use = await db.scalar(
        select(OrgMember.id).where(OrgMember.role_id == role_id).limit(1)
    )
    if in_use:
        # Deleting it would leave members with a dangling role and no
        # permissions at all; making the caller reassign first is the honest
        # failure.
        raise HTTPException(
            status_code=409,
            detail="This role is still assigned to members. Reassign them first.",
        )

    slug = role.slug
    await db.delete(role)
    await record(
        db,
        action="role.deleted",
        actor_id=user.id,
        org_id=org_id,
        payload={"slug": slug},
        request=request,
    )
    await db.commit()
    return {"deleted": True}
