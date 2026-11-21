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


async def another_approver(
    db: AsyncSession, *, project_id: str, org_id: str, user_id: str
) -> bool:
    """Whether someone other than ``user_id`` may approve on this project."""
    for candidate in await _candidates(db, project_id, org_id, user_id):
        person = await db.get(User, candidate)
        if person is None or not person.is_active:
            continue
        permissions, _ = await resolve_permissions(
            db,
            user_id=person.id,
            platform_role=person.role,
            org_id=org_id,
            project_id=project_id,
        )
        if APPROVAL in permissions:
            return True
    return False


async def may_approve_own(
    db: AsyncSession,
    *,
    project_id: str,
    org_id: str,
    user_id: str,
    author_id: str | None,
) -> bool:
    """Whether ``user_id`` may approve a card ``author_id`` created.

    Someone else's card, or one with no known author, is always theirs to
    approve (the permission is checked by the route).
    """
    if not author_id or author_id != user_id:
        return True
    policy = get_settings().self_approval
    if policy == "allow":
        return True
    if policy == "deny":
        return False
    return not await another_approver(
        db, project_id=project_id, org_id=org_id, user_id=user_id
    )
