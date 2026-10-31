"""What a person inherits from their groups.

A group (:class:`server.db.models.UserGroup`) lives in one organization. Its
members inherit two things, always added to what they hold themselves and
never taking anything away:

- the group's organization role, whose permissions join their own;
- the group's role on each project it is given (``ProjectGroup``): their
  project role is the highest of their own and their groups'.

A membership counts only while the person belongs to the group's
organization, and a project grant only on a project of that organization: a
group cannot carry anyone across tenants. Every query below enforces both.
"""

from __future__ import annotations

from server.db.models import (
    GroupMember,
    OrgMember,
    Project,
    ProjectGroup,
    ProjectRole,
    Role,
    UserGroup,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: The project roles, lowest first (the ladder ``require_project_role`` ranks).
PROJECT_ROLE_RANK = {
    ProjectRole.VIEWER.value: 0,
    ProjectRole.MEMBER.value: 1,
    ProjectRole.OWNER.value: 2,
}


def highest_role(*roles: str | None) -> str | None:
    """The highest of these project roles; unknown values count for nothing."""
    known = [r for r in roles if r in PROJECT_ROLE_RANK]
    return max(known, key=PROJECT_ROLE_RANK.__getitem__) if known else None


def _member_groups(user_id: str):
    """The groups this person belongs to, while they belong to its org."""
    return (
        select(UserGroup.id)
        .join(GroupMember, GroupMember.group_id == UserGroup.id)
        .join(
            OrgMember,
            (OrgMember.org_id == UserGroup.org_id) & (OrgMember.user_id == user_id),
        )
        .where(GroupMember.user_id == user_id)
    )


async def group_org_roles(db: AsyncSession, user_id: str, org_id: str) -> list[Role]:
    """The organization roles this person's groups in ``org_id`` give them."""
    groups = _member_groups(user_id).where(UserGroup.org_id == org_id)
    return list(
        await db.scalars(
            select(Role)
            .join(UserGroup, UserGroup.role_id == Role.id)
            .where(UserGroup.id.in_(groups))
            # A role of another tenant (never written, but never trusted).
            .where((Role.org_id.is_(None)) | (Role.org_id == org_id))
        )
    )


async def group_project_roles(
    db: AsyncSession, user_id: str, org_id: str | None = None
) -> dict[str, str]:
    """Project id → the highest role this person's groups give them there."""
    query = (
        select(ProjectGroup.project_id, ProjectGroup.role)
        .join(UserGroup, UserGroup.id == ProjectGroup.group_id)
        .join(Project, Project.id == ProjectGroup.project_id)
        .where(ProjectGroup.group_id.in_(_member_groups(user_id)))
        .where(Project.org_id == UserGroup.org_id)
    )
    if org_id is not None:
        query = query.where(Project.org_id == org_id)
    roles: dict[str, str] = {}
    for project_id, role in (await db.execute(query)).all():
        best = highest_role(roles.get(project_id), role)
        if best is not None:
            roles[project_id] = best
    return roles


async def group_project_role(
    db: AsyncSession, user_id: str, project_id: str
) -> str | None:
    """The highest role this person's groups give them on one project."""
    query = (
        select(ProjectGroup.role)
        .join(UserGroup, UserGroup.id == ProjectGroup.group_id)
        .join(Project, Project.id == ProjectGroup.project_id)
        .where(ProjectGroup.project_id == project_id)
        .where(ProjectGroup.group_id.in_(_member_groups(user_id)))
        .where(Project.org_id == UserGroup.org_id)
    )
    return highest_role(*(await db.scalars(query)))
