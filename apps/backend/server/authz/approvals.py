"""The approvals of a card's spec: who gave them, and whether they are enough.

The board's routes record here each person's approval of a card
(``spec_approvals``) and ask whether the card now has what its criticality
needs (``server/authz/approval_policy.py``): enough approvals of the current
``spec.md`` and plan, from distinct approvers, among them someone holding each
role the criticality names. Only then does the board write the approval the
build checks.

An approval belongs to a place in the quorum (``slot_id``): the approver's
own, or the one of the approver a delegate stands in for. One person fills one
place per version of a card, and one place is filled once.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from server.authz.approval_policy import (
    Requirement,
    content_hash,
    effective_criticality,
    requirement_for,
)
from server.authz.engine import org_role_for, project_role_for
from server.authz.groups import group_org_roles
from server.authz.principal import Principal
from server.authz.self_approval import may_approve_own
from server.db.models import SpecApproval, SpecCriticality, User
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class ApprovalStatus:
    """Where a card's approval stands, for its current spec and plan."""

    criticality: str
    source: str
    requirement: Requirement
    approvals: list[dict[str, Any]] = field(default_factory=list)
    missing_roles: list[str] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return len(self.approvals) >= self.requirement.needed and not self.missing_roles

    def public(self) -> dict[str, Any]:
        return {
            "criticality": self.criticality,
            "criticalitySource": self.source,
            "needed": self.requirement.needed,
            "roles": list(self.requirement.roles),
            "missingRoles": list(self.missing_roles),
            "count": len(self.approvals),
            "approvals": self.approvals,
            "complete": self.complete,
        }


async def chosen_criticality(
    db: AsyncSession, project_id: str, spec_name: str
) -> str | None:
    row = await db.get(SpecCriticality, (project_id, spec_name))
    return row.criticality if row is not None else None


async def criticality_of(
    db: AsyncSession, project_id: str, spec_name: str | None, card_dir: Path | None
) -> tuple[str, str]:
    chosen = await chosen_criticality(db, project_id, spec_name) if spec_name else None
    return effective_criticality(chosen, card_dir)


async def role_slugs(
    db: AsyncSession, *, user_id: str, org_id: str, project_id: str
) -> list[str]:
    """The slugs of every role this person holds there: organization, groups, project."""
    roles = [await org_role_for(db, user_id, org_id)]
    roles += await group_org_roles(db, user_id, org_id)
    roles.append(await project_role_for(db, user_id, project_id))
    return sorted({role.slug for role in roles if role is not None})


async def _names(db: AsyncSession, ids: set[str]) -> dict[str, str]:
    if not ids:
        return {}
    rows = await db.execute(
        select(User.id, User.display_name, User.email).where(User.id.in_(ids))
    )
    return {uid: name or email for uid, name, email in rows.all()}


async def approval_status(
    db: AsyncSession, *, project_id: str, spec_name: str, card_dir: Path
) -> ApprovalStatus:
    criticality, source = await criticality_of(db, project_id, spec_name, card_dir)
    requirement = requirement_for(criticality)
    rows = list(
        await db.scalars(
            select(SpecApproval)
            .where(
                SpecApproval.project_id == project_id,
                SpecApproval.spec_name == spec_name,
                SpecApproval.content_hash == content_hash(card_dir),
            )
            .order_by(SpecApproval.created_at)
        )
    )
    names = await _names(
        db, {i for r in rows for i in (r.user_id, r.acting_for) if i is not None}
    )
    held = {slug for row in rows for slug in row.roles or ()}
    return ApprovalStatus(
        criticality=criticality,
        source=source,
        requirement=requirement,
        approvals=[
            {
                "by": names.get(row.user_id or "", "?"),
                "for": names.get(row.acting_for, "?") if row.acting_for else None,
                "at": row.created_at.isoformat(),
                "roles": list(row.roles or ()),
            }
            for row in rows
        ],
        missing_roles=[slug for slug in requirement.roles if slug not in held],
    )


async def may_give(
    db: AsyncSession,
    *,
    project_id: str,
    org_id: str,
    person_id: str,
    slot_id: str,
    author_id: str | None,
    needed: int,
) -> bool:
    """Whether this approval may be given, under the self-approval rule.

    Standing in for the card's author, or being it while standing in for
    someone else, is the author approving their own card.
    """
    if author_id is None or author_id not in (person_id, slot_id):
        return True
    return await may_approve_own(
        db,
        project_id=project_id,
        org_id=org_id,
        user_id=author_id,
        author_id=author_id,
        needed=needed,
    )


async def record_approval(
    db: AsyncSession,
    *,
    project_id: str,
    org_id: str,
    spec_name: str,
    card_dir: Path,
    person_id: str,
    slot_id: str,
    criticality: str,
) -> bool:
    """Record this approval of the card as it stands; False when already given.

    It is not committed: the caller commits it with its audit entry.
    """
    digest = content_hash(card_dir)
    existing = await db.scalar(
        select(SpecApproval.id).where(
            SpecApproval.project_id == project_id,
            SpecApproval.spec_name == spec_name,
            SpecApproval.content_hash == digest,
            (SpecApproval.user_id == person_id) | (SpecApproval.slot_id == slot_id),
        )
    )
    if existing is not None:
        return False
    db.add(
        SpecApproval(
            project_id=project_id,
            spec_name=spec_name,
            content_hash=digest,
            user_id=person_id,
            slot_id=slot_id,
            acting_for=slot_id if slot_id != person_id else None,
            criticality=criticality,
            roles=await role_slugs(
                db, user_id=slot_id, org_id=org_id, project_id=project_id
            ),
        )
    )
    try:
        await db.flush()
    except IntegrityError:
        # The same place filled at the same moment by another request.
        await db.rollback()
        return False
    return True


async def may_approve_alone(
    db: AsyncSession,
    *,
    principal: Principal,
    project_id: str,
    org_id: str,
    author_id: str | None,
    spec_name: str | None = None,
    card_dir: Path | None = None,
) -> bool:
    """Whether this person's approval alone is enough for the card.

    Going without a review is approving: only someone whose single approval
    meets the card's requirement may start it without one.
    """
    slot = principal.approval_slot(project_id)
    if slot is None:
        return False
    criticality, _ = await criticality_of(db, project_id, spec_name, card_dir)
    requirement = requirement_for(criticality)
    if requirement.needed > 1:
        return False
    if requirement.roles:
        held = await role_slugs(db, user_id=slot, org_id=org_id, project_id=project_id)
        if not set(requirement.roles) <= set(held):
            return False
    return await may_give(
        db,
        project_id=project_id,
        org_id=org_id,
        person_id=principal.id,
        slot_id=slot,
        author_id=author_id,
        needed=1,
    )
