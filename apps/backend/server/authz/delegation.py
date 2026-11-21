"""Lending one's approval on a project for a while (holidays, on-call).

An approver of a project names a colleague on it and a period. During that
period the colleague approves the project's cards in the approver's name: the
approval fills the approver's place in a card's quorum, with the approver's
roles, and is recorded as given by the colleague for the approver.

What it lends is exactly what the approver holds: a delegation counts only
while its approver is active and may still approve on that project, and it
reaches only the two answers to a card's review (``DELEGATED_ROUTES`` of
``server/authz/mounting.py``). A delegate never lends it on, never sets a
card's criticality, and approving a card the approver created is the
approver approving their own card.

A person who leaves (an account deactivated, a member removed from the
organization or the project) ends every open delegation they lent or hold
there (:func:`end_delegations_of`). Nothing else is waiting on them: a
card's quorum counts places any approver fills, never named people, and the
approvals they already gave stay as the record of who approved what.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from server.authz.self_approval import holds_approval
from server.db.models import ApprovalDelegation
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

#: The longest one delegation lasts, and how far ahead it may start.
MAX_LENGTH = timedelta(days=90)
MAX_LEAD = timedelta(days=365)
#: Delegations one approver has running or planned on one project.
MAX_OPEN = 5


def aware(moment: datetime) -> datetime:
    """``moment`` in UTC; a naive one (SQLite returns them) is taken as UTC."""
    if moment.tzinfo is None:
        return moment.replace(tzinfo=UTC)
    return moment.astimezone(UTC)


async def delegations_to(
    db: AsyncSession, *, user_id: str, org_id: str, now: datetime | None = None
) -> tuple[tuple[str, str], ...]:
    """``(project_id, approver_id)`` of each delegation ``user_id`` holds now.

    One per project, the oldest; one whose approver can no longer approve
    there lends nothing.
    """
    now = now or datetime.now(UTC)
    rows = await db.scalars(
        select(ApprovalDelegation)
        .where(
            ApprovalDelegation.to_user_id == user_id,
            ApprovalDelegation.org_id == org_id,
            ApprovalDelegation.revoked_at.is_(None),
            ApprovalDelegation.ends_at > now,
        )
        .order_by(ApprovalDelegation.created_at)
    )
    lent: dict[str, str] = {}
    for row in rows:
        if row.project_id in lent or aware(row.starts_at) > now:
            continue
        if await holds_approval(
            db, project_id=row.project_id, org_id=org_id, user_id=row.from_user_id
        ):
            lent[row.project_id] = row.from_user_id
    return tuple(lent.items())


async def end_delegations_of(
    db: AsyncSession,
    *,
    user_id: str,
    org_id: str | None = None,
    project_id: str | None = None,
    now: datetime | None = None,
) -> int:
    """End now every open delegation ``user_id`` lent or holds; how many.

    Within ``org_id`` or ``project_id`` when given (a person leaving one
    organization or project), everywhere otherwise (an account deactivated).
    The caller commits, with its own audit entry.
    """
    now = now or datetime.now(UTC)
    query = select(ApprovalDelegation).where(
        or_(
            ApprovalDelegation.from_user_id == user_id,
            ApprovalDelegation.to_user_id == user_id,
        ),
        ApprovalDelegation.revoked_at.is_(None),
        ApprovalDelegation.ends_at > now,
    )
    if org_id is not None:
        query = query.where(ApprovalDelegation.org_id == org_id)
    if project_id is not None:
        query = query.where(ApprovalDelegation.project_id == project_id)
    rows = list(await db.scalars(query))
    for row in rows:
        row.revoked_at = now
    return len(rows)
