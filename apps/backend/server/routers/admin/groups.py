"""Groups of people in the organization the caller administers.

A group gathers members of one organization (« Front team », « QA ») so they
can be given access together: an organization role every member inherits on
top of their own, and a role on chosen projects (``server.authz.groups``
decides what each person ends up with).

Managing a group hands out access, so its routes need the permissions that
already hand it out one person at a time: ``org.member.read`` to read,
``org.member.write`` to change a group or its members, and
``project.member.write`` to give a group a role on a project. Everything is
scoped to the caller's organization: a group, person, role or project of
another tenant answers 404.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from server.auth.deps import CurrentUser
from server.authz.deps import require_org, require_permission
from server.authz.roles import ORG_SCOPE
from server.db.engine import get_db
from server.db.models import (
    GroupMember,
    OrgMember,
    Project,
    ProjectGroup,
    ProjectRole,
    Role,
    User,
    UserGroup,
)
from server.services.audit import record
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/admin", tags=["admin:groups"])

_PROJECT_ROLES = {r.value for r in ProjectRole}


class GroupMemberPublic(BaseModel):
    user_id: str
    email: str
    display_name: str


class GroupProjectPublic(BaseModel):
    project_id: str
    name: str
    role: str


class GroupPublic(BaseModel):
    id: str
    name: str
    description: str
    role_slug: str | None
    role_name: str | None
    members: list[GroupMemberPublic]
    projects: list[GroupProjectPublic]
    created_at: datetime


class CreateGroupRequest(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=2000)
    role_slug: str | None = Field(default=None, max_length=60)


class UpdateGroupRequest(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=2000)
    # "" removes the group's organization role; None leaves it as it is.
    role_slug: str | None = Field(default=None, max_length=60)


class GroupProjectRequest(BaseModel):
    role: str = Field(max_length=20)


async def _group(db: AsyncSession, org_id: str, group_id: str) -> UserGroup:
    group = await db.scalar(
        select(UserGroup).where(UserGroup.id == group_id, UserGroup.org_id == org_id)
    )
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    return group


async def _org_role(db: AsyncSession, org_id: str, slug: str) -> Role:
    """A role of this organization (or built in) that applies org-wide."""
    role = await db.scalar(
        select(Role).where(
            Role.slug == slug,
            Role.scope == ORG_SCOPE,
            or_(Role.org_id.is_(None), Role.org_id == org_id),
        )
    )
    if role is None:
        raise HTTPException(status_code=400, detail=f"Unknown role '{slug}'")
    return role


async def _public(db: AsyncSession, group: UserGroup) -> GroupPublic:
    role = await db.get(Role, group.role_id) if group.role_id else None
    members = await db.execute(
        select(User)
        .join(GroupMember, GroupMember.user_id == User.id)
        .join(
            OrgMember,
            (OrgMember.user_id == User.id) & (OrgMember.org_id == group.org_id),
        )
        .where(GroupMember.group_id == group.id)
        .order_by(User.display_name)
    )
    projects = await db.execute(
        select(Project, ProjectGroup.role)
        .join(ProjectGroup, ProjectGroup.project_id == Project.id)
        .where(ProjectGroup.group_id == group.id, Project.org_id == group.org_id)
        .order_by(Project.name)
    )
    return GroupPublic(
        id=group.id,
        name=group.name,
        description=group.description or "",
        role_slug=role.slug if role else None,
        role_name=role.name if role else None,
        members=[
            GroupMemberPublic(
                user_id=user.id, email=user.email, display_name=user.display_name
            )
            for user in members.scalars()
        ],
        projects=[
            GroupProjectPublic(project_id=project.id, name=project.name, role=role)
            for project, role in projects.all()
        ],
        created_at=group.created_at,
    )


async def _commit_or_conflict(db: AsyncSession) -> None:
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status_code=409, detail="A group with this name exists"
        ) from exc


@router.get("/groups", response_model=list[GroupPublic])
async def list_groups(
    org_id: str = Depends(require_org),
    _: CurrentUser = Depends(require_permission("org.member.read")),
    db: AsyncSession = Depends(get_db),
) -> list[GroupPublic]:
    groups = await db.scalars(
        select(UserGroup).where(UserGroup.org_id == org_id).order_by(UserGroup.name)
    )
    return [await _public(db, group) for group in groups.all()]


@router.post("/groups", response_model=GroupPublic, status_code=201)
async def create_group(
    body: CreateGroupRequest,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> GroupPublic:
    role = await _org_role(db, org_id, body.role_slug) if body.role_slug else None
    group = UserGroup(
        org_id=org_id,
        name=body.name.strip(),
        description=body.description,
        role_id=role.id if role else None,
    )
    db.add(group)
    await record(
        db,
        action="org.group.created",
        actor_id=actor.id,
        org_id=org_id,
        payload={"name": group.name, "role": role.slug if role else None},
        request=request,
    )
    await _commit_or_conflict(db)
    return await _public(db, group)


@router.patch("/groups/{group_id}", response_model=GroupPublic)
async def update_group(
    group_id: str,
    body: UpdateGroupRequest,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> GroupPublic:
    group = await _group(db, org_id, group_id)
    changes: dict[str, str | None] = {}
    if body.name is not None:
        group.name = body.name.strip()
        changes["name"] = group.name
    if body.description is not None:
        group.description = body.description
    if body.role_slug is not None:
        role = await _org_role(db, org_id, body.role_slug) if body.role_slug else None
        group.role_id = role.id if role else None
        changes["role"] = role.slug if role else None
    await record(
        db,
        action="org.group.updated",
        actor_id=actor.id,
        org_id=org_id,
        payload={"group_id": group.id, **changes},
        request=request,
    )
    await _commit_or_conflict(db)
    return await _public(db, group)


@router.delete("/groups/{group_id}")
async def delete_group(
    group_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> dict:
    group = await _group(db, org_id, group_id)
    for model in (GroupMember, ProjectGroup):
        for row in await db.scalars(select(model).where(model.group_id == group.id)):
            await db.delete(row)
    await db.delete(group)
    await record(
        db,
        action="org.group.deleted",
        actor_id=actor.id,
        org_id=org_id,
        payload={"group_id": group_id, "name": group.name},
        request=request,
    )
    await db.commit()
    return {"deleted": True}


@router.put("/groups/{group_id}/members/{member_user_id}", response_model=GroupPublic)
async def add_group_member(
    group_id: str,
    member_user_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> GroupPublic:
    group = await _group(db, org_id, group_id)
    member = await db.scalar(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id, OrgMember.user_id == member_user_id
        )
    )
    if member is None:
        raise HTTPException(status_code=404, detail="Not a member of this organization")
    exists = await db.scalar(
        select(GroupMember.id).where(
            GroupMember.group_id == group.id, GroupMember.user_id == member_user_id
        )
    )
    if exists is None:
        db.add(GroupMember(group_id=group.id, user_id=member_user_id))
        await record(
            db,
            action="org.group.member_added",
            actor_id=actor.id,
            org_id=org_id,
            payload={"group_id": group.id, "user_id": member_user_id},
            request=request,
        )
        await db.commit()
    return await _public(db, group)


@router.delete(
    "/groups/{group_id}/members/{member_user_id}", response_model=GroupPublic
)
async def remove_group_member(
    group_id: str,
    member_user_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("org.member.write")),
    db: AsyncSession = Depends(get_db),
) -> GroupPublic:
    group = await _group(db, org_id, group_id)
    row = await db.scalar(
        select(GroupMember).where(
            GroupMember.group_id == group.id, GroupMember.user_id == member_user_id
        )
    )
    if row is not None:
        await db.delete(row)
        await record(
            db,
            action="org.group.member_removed",
            actor_id=actor.id,
            org_id=org_id,
            payload={"group_id": group.id, "user_id": member_user_id},
            request=request,
        )
        await db.commit()
    return await _public(db, group)


@router.put("/groups/{group_id}/projects/{project_id}", response_model=GroupPublic)
async def set_group_project_role(
    group_id: str,
    project_id: str,
    body: GroupProjectRequest,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("project.member.write")),
    db: AsyncSession = Depends(get_db),
) -> GroupPublic:
    if body.role not in _PROJECT_ROLES:
        raise HTTPException(
            status_code=400, detail=f"Unknown project role '{body.role}'"
        )
    group = await _group(db, org_id, group_id)
    project = await db.scalar(
        select(Project).where(Project.id == project_id, Project.org_id == org_id)
    )
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    grant = await db.scalar(
        select(ProjectGroup).where(
            ProjectGroup.group_id == group.id, ProjectGroup.project_id == project.id
        )
    )
    if grant is None:
        db.add(ProjectGroup(group_id=group.id, project_id=project.id, role=body.role))
    else:
        grant.role = body.role
    await record(
        db,
        action="project.group.role_set",
        actor_id=actor.id,
        org_id=org_id,
        project_id=project.id,
        payload={"group_id": group.id, "role": body.role},
        request=request,
    )
    await db.commit()
    return await _public(db, group)


@router.delete("/groups/{group_id}/projects/{project_id}", response_model=GroupPublic)
async def remove_group_project(
    group_id: str,
    project_id: str,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("project.member.write")),
    db: AsyncSession = Depends(get_db),
) -> GroupPublic:
    group = await _group(db, org_id, group_id)
    grant = await db.scalar(
        select(ProjectGroup)
        .join(Project, Project.id == ProjectGroup.project_id)
        .where(
            ProjectGroup.group_id == group.id,
            ProjectGroup.project_id == project_id,
            Project.org_id == org_id,
        )
    )
    if grant is not None:
        await db.delete(grant)
        await record(
            db,
            action="project.group.removed",
            actor_id=actor.id,
            org_id=org_id,
            project_id=project_id,
            payload={"group_id": group.id},
            request=request,
        )
        await db.commit()
    return await _public(db, group)
