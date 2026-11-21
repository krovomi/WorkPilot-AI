"""Approving the spec of a card one created.

Approving a spec is the ``review.approve`` permission; on top of it, the
deployment chooses whether the card's own author may give that approval
(``WORKPILOT_SELF_APPROVAL``):

* ``allow``: yes, as before;
* ``deny``: never, someone else approves;
* ``when-alone`` (the default): not while another member of the project may
  approve it, so a team reviews its own work and a person alone on a project
  is never stuck.

"Another member" is a person with a role of ``member`` or ``owner`` on the
project, given to them or to one of their groups, whose permissions there
include ``review.approve``. Going without a review is approving: the same
rule decides whether a card's author may start it without one.

When a card needs several approvals (``server/authz/approvals.py``), the
author's own counts only while the others could not reach that number alone.
"""

from __future__ import annotations

from server.authz.engine import resolve_permissions
from server.config import get_settings
from server.db.models import (
    GroupMember,
    OrgMember,
    ProjectGroup,
    ProjectMember,
    ProjectRole,
    User,
    UserGroup,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

APPROVAL = "review.approve"
#: The project roles that can change a card, hence approve one.
_WRITER_ROLES = (ProjectRole.MEMBER.value, ProjectRole.OWNER.value)
#: At most this many people are looked at; a project that large has an approver.
MAX_CANDIDATES = 200


async def _candidates(
    db: AsyncSession, project_id: str, org_id: str, exclude: str
) -> list[str]:
    """People with a writer role on the project, directly or by a group."""
    direct = select(ProjectMember.user_id).where(
        ProjectMember.project_id == project_id,
        ProjectMember.role.in_(_WRITER_ROLES),
    )
    by_group = (
        select(GroupMember.user_id)
        .join(UserGroup, UserGroup.id == GroupMember.group_id)
        .join(ProjectGroup, ProjectGroup.group_id == UserGroup.id)
        .join(
            OrgMember,
            (OrgMember.org_id == UserGroup.org_id)
            & (OrgMember.user_id == GroupMember.user_id),
        )
        .where(
            ProjectGroup.project_id == project_id,
            ProjectGroup.role.in_(_WRITER_ROLES),
            UserGroup.org_id == org_id,
        )
    )
    ids = set(await db.scalars(direct)) | set(await db.scalars(by_group))
    ids.discard(exclude)
    return sorted(ids)[:MAX_CANDIDATES]


async def holds_approval(
    db: AsyncSession, *, project_id: str, org_id: str, user_id: str
) -> bool:
    """Whether this active person's own roles let them approve on the project."""
    person = await db.get(User, user_id)
    if person is None or not person.is_active:
        return False
    permissions, _ = await resolve_permissions(
        db,
        user_id=person.id,
        platform_role=person.role,
        org_id=org_id,
        project_id=project_id,
    )
    return APPROVAL in permissions


async def other_approvers(
    db: AsyncSession, *, project_id: str, org_id: str, user_id: str, limit: int = 1
) -> int:
    """How many people other than ``user_id`` may approve here, up to ``limit``."""
    found = 0
    for candidate in await _candidates(db, project_id, org_id, user_id):
        if await holds_approval(
            db, project_id=project_id, org_id=org_id, user_id=candidate
        ):
            found += 1
            if found >= limit:
                break
    return found


async def another_approver(
    db: AsyncSession, *, project_id: str, org_id: str, user_id: str
) -> bool:
    """Whether someone other than ``user_id`` may approve on this project."""
    return bool(
        await other_approvers(db, project_id=project_id, org_id=org_id, user_id=user_id)
    )


async def may_approve_own(
    db: AsyncSession,
    *,
    project_id: str,
    org_id: str,
    user_id: str,
    author_id: str | None,
    needed: int = 1,
) -> bool:
    """Whether ``user_id`` may approve a card ``author_id`` created.

    Someone else's card, or one with no known author, is always theirs to
    approve (the permission is checked by the route). Under ``when-alone``,
    the author adds their approval only while the others who may approve are
    fewer than the ``needed`` approvals of the card: a team of two still
    reaches a quorum of two.
    """
    if not author_id or author_id != user_id:
        return True
    policy = get_settings().self_approval
    if policy == "allow":
        return True
    if policy == "deny":
        return False
    others = await other_approvers(
        db, project_id=project_id, org_id=org_id, user_id=user_id, limit=needed
    )
    return others < needed
