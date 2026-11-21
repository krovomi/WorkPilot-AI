"""Server mode: approving a card's spec, by as many people as it needs.

A card is approved once it has the approvals its criticality asks for
(``server/authz/approval_policy.py``): each approver's is recorded in the
server's database (``server/authz/approvals.py``), against the SHA-256 of the
card's ``spec.md`` and plan, and the approval the build checks
(``review_state.json``) is written only when they are enough. Editing the spec
or the plan voids the approvals given before.

Routes, on the board's router (``/api/board``), each with its permission in
``ROUTE_OVERRIDES`` or derived from its verb:

- ``POST /cards/{id}/approve`` (``review.approve``, or an approval lent for the
  project): adds this person's approval;
- ``GET /cards/{id}/approvals`` (``task.read``): where the approval stands;
- ``PUT /cards/{id}/criticality`` (``review.approve``): how critical the card
  is; its author lowers it only as the self-approval rule lets them approve;
- ``GET /delegations`` (``task.read``), ``POST /delegations`` and
  ``DELETE /delegations/{id}`` (``review.approve``): approvals lent on the
  project (``server/authz/delegation.py``).

Each approval, criticality and delegation is written to the organization's
audit log, with the approver's roles and whom a delegate stood in for.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from server.authz.approval_policy import rank, requirement_for
from server.authz.approvals import (
    ApprovalStatus,
    approval_status,
    criticality_of,
    may_give,
    record_approval,
)
from server.authz.delegation import MAX_LEAD, MAX_LENGTH, MAX_OPEN, aware
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.authz.self_approval import _candidates, may_approve_own
from server.db.engine import get_db
from server.db.models import ApprovalDelegation, SpecCriticality, SpecIndex, User
from server.services import audit
from server.services.events import emit_board_event
from shared_board.cards import _card_or_404, _index_row, _require_writer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/board", tags=["board"])

#: Why the author of a card may not approve it (``server/authz/self_approval``).
OWN_CARD = "Someone else approves the spec of a card you created"
OWN_CRITICALITY = "Someone else lowers the criticality of a card you created"


def _approved(directory: Path) -> bool:
    from review.state import ReviewState

    return ReviewState.load(directory).is_approval_valid(directory)


def _write_approval(directory: Path, status: ApprovalStatus) -> str:
    """The approval the build checks, in the names of those who gave it."""
    from review.state import ReviewState

    names = [
        a["by"] if not a["for"] else f"{a['by']} for {a['for']}"
        for a in status.approvals
    ]
    review = ReviewState.load(directory)
    review.approve(directory, approved_by=", ".join(names)[:500])
    return review.approved_by


def _void_approval(directory: Path) -> None:
    from review.state import ReviewState

    ReviewState.load(directory).invalidate(directory)


async def give_approval(
    db: AsyncSession,
    scope: ProjectScope,
    principal: Principal,
    directory: Path,
    row: SpecIndex | None,
    request: Request,
) -> tuple[ApprovalStatus, bool] | None:
    """Add this person's approval of the card as it stands.

    ``(status, added)``; None when the self-approval rule refuses it. When
    the approvals are then enough, the build's approval is written.
    """
    card_id = directory.name
    slot = principal.approval_slot(scope.project_id)
    if slot is None:  # The route's permission already refused them.
        return None
    criticality, _ = await criticality_of(db, scope.project_id, card_id, directory)
    if not await may_give(
        db,
        project_id=scope.project_id,
        org_id=scope.org_id,
        person_id=principal.id,
        slot_id=slot,
        author_id=row.created_by if row is not None else None,
        needed=requirement_for(criticality).needed,
    ):
        return None
    added = await record_approval(
        db,
        project_id=scope.project_id,
        org_id=scope.org_id,
        spec_name=card_id,
        card_dir=directory,
        person_id=principal.id,
        slot_id=slot,
        criticality=criticality,
    )
    status = await approval_status(
        db, project_id=scope.project_id, spec_name=card_id, card_dir=directory
    )
    if added:
        await audit.record(
            db,
            action="review.approved",
            actor_id=principal.id,
            org_id=scope.org_id,
            project_id=scope.project_id,
            payload={
                "spec": card_id,
                "criticality": criticality,
                "acting_for": slot if slot != principal.id else None,
                "count": len(status.approvals),
                "needed": status.requirement.needed,
                "complete": status.complete,
            },
            request=request,
        )
        await db.commit()
    if status.complete and not _approved(directory):
        _write_approval(directory, status)
    return status, added


async def approve_card(
    card_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Add this person's approval of the card's spec and plan.

    The build may start once the card has the approvals its criticality
    needs; ``approved`` says whether it has them. The card's author approves
    it only as the deployment allows (``WORKPILOT_SELF_APPROVAL``).
    """
    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    if not (directory / "spec.md").is_file():
        raise HTTPException(status_code=409, detail="No spec to approve yet")
    if principal.approval_slot(scope.project_id) is None:
        raise HTTPException(
            status_code=403, detail="Missing permission: review.approve"
        )
    row = await _index_row(db, scope, card_id)
    given = await give_approval(db, scope, principal, directory, row, request)
    if given is None:
        raise HTTPException(status_code=403, detail=OWN_CARD)
    status, _ = given
    approved = _approved(directory)
    event = "spec_approved" if approved else "spec_updated"
    emit_board_event(scope.project_id, event, {"spec": card_id, "by": principal.id})
    from review.state import ReviewState

    return {
        "approved": approved,
        "approvedBy": ReviewState.load(directory).approved_by if approved else None,
        "approval": status.public(),
    }


async def card_approvals(
    card_id: str,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Where the card's approval stands: its criticality, who approved, what is missing."""
    directory = _card_or_404(scope, card_id)
    status = await approval_status(
        db, project_id=scope.project_id, spec_name=card_id, card_dir=directory
    )
    return {**status.public(), "approved": _approved(directory)}


class CriticalityChange(BaseModel):
    criticality: Literal["low", "medium", "high"]


async def set_criticality(
    card_id: str,
    body: CriticalityChange,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Say how critical the card is, which sets how many approve it.

    Raising it voids an approval that is no longer enough; lowering it may
    complete one. The card's author lowers it only when they could approve
    their own card.
    """
    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    before, _ = await criticality_of(db, scope.project_id, card_id, directory)
    after = body.criticality
    row = await _index_row(db, scope, card_id)
    author = row.created_by if row is not None else None
    if rank(after) < rank(before) and not await may_approve_own(
        db,
        project_id=scope.project_id,
        org_id=scope.org_id,
        user_id=principal.id,
        author_id=author,
        needed=requirement_for(before).needed,
    ):
        raise HTTPException(status_code=403, detail=OWN_CRITICALITY)

    chosen = await db.get(SpecCriticality, (scope.project_id, card_id))
    if chosen is None:
        chosen = SpecCriticality(project_id=scope.project_id, spec_name=card_id)
        db.add(chosen)
    chosen.criticality = after
    chosen.set_by = principal.id
    chosen.set_at = datetime.now(UTC)
    await audit.record(
        db,
        action="review.criticality.set",
        actor_id=principal.id,
        org_id=scope.org_id,
        project_id=scope.project_id,
        payload={"spec": card_id, "from": before, "to": after},
        request=request,
    )
    await db.commit()

    status = await approval_status(
        db, project_id=scope.project_id, spec_name=card_id, card_dir=directory
    )
    approved = _approved(directory)
    if status.complete and not approved:
        _write_approval(directory, status)
    elif not status.complete and approved and rank(after) > rank(before):
        _void_approval(directory)
    emit_board_event(
        scope.project_id, "spec_updated", {"spec": card_id, "by": principal.id}
    )
    return {**status.public(), "approved": _approved(directory)}


# --- Delegations ---------------------------------------------------------------


class DelegationCreate(BaseModel):
    to_user_id: str = Field(min_length=1, max_length=36)
    ends_at: datetime
    starts_at: datetime | None = None


def _delegation_public(row: ApprovalDelegation, names: dict[str, str]) -> dict:
    now = datetime.now(UTC)
    return {
        "id": row.id,
        "from": {"id": row.from_user_id, "name": names.get(row.from_user_id, "?")},
        "to": {"id": row.to_user_id, "name": names.get(row.to_user_id, "?")},
        "startsAt": aware(row.starts_at).isoformat(),
        "endsAt": aware(row.ends_at).isoformat(),
        "active": aware(row.starts_at) <= now < aware(row.ends_at),
    }


async def _people(db: AsyncSession, rows: list[ApprovalDelegation]) -> dict[str, str]:
    ids = {i for r in rows for i in (r.from_user_id, r.to_user_id)}
    if not ids:
        return {}
    found = await db.execute(
        select(User.id, User.display_name, User.email).where(User.id.in_(ids))
    )
    return {uid: name or email for uid, name, email in found.all()}


def _open(project_id: str, now: datetime):
    return select(ApprovalDelegation).where(
        ApprovalDelegation.project_id == project_id,
        ApprovalDelegation.revoked_at.is_(None),
        ApprovalDelegation.ends_at > now,
    )


@router.get("/delegations")
async def list_delegations(
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """The approvals lent on this project, running or to come."""
    rows = list(
        await db.scalars(
            _open(scope.project_id, datetime.now(UTC)).order_by(
                ApprovalDelegation.starts_at
            )
        )
    )
    names = await _people(db, rows)
    return [_delegation_public(row, names) for row in rows]


@router.post("/delegations", status_code=201)
async def create_delegation(
    body: DelegationCreate,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Lend one's approval on this project to a colleague, for a while.

    The colleague is a writer of the project, active, of this organization;
    the period lasts at most 90 days and starts within a year.
    """
    principal = get_principal(request)
    _require_writer(scope, principal)
    if body.to_user_id == principal.id:
        raise HTTPException(status_code=422, detail="Lend it to someone else")
    now = datetime.now(UTC)
    starts = aware(body.starts_at) if body.starts_at else now
    ends = aware(body.ends_at)
    if ends <= max(starts, now):
        raise HTTPException(status_code=422, detail="The period has to end later")
    if ends - starts > MAX_LENGTH or starts - now > MAX_LEAD:
        raise HTTPException(
            status_code=422,
            detail="A delegation lasts at most 90 days and starts within a year",
        )
    writers = await _candidates(db, scope.project_id, scope.org_id, principal.id)
    delegate = await db.get(User, body.to_user_id)
    if body.to_user_id not in writers or delegate is None or not delegate.is_active:
        raise HTTPException(
            status_code=422, detail="Lend it to an active member of this project"
        )
    mine = list(
        await db.scalars(
            _open(scope.project_id, now).where(
                ApprovalDelegation.from_user_id == principal.id
            )
        )
    )
    if len(mine) >= MAX_OPEN:
        raise HTTPException(status_code=409, detail="Too many delegations already")

    row = ApprovalDelegation(
        org_id=scope.org_id,
        project_id=scope.project_id,
        from_user_id=principal.id,
        to_user_id=body.to_user_id,
        starts_at=starts,
        ends_at=ends,
    )
    db.add(row)
    await db.flush()
    await audit.record(
        db,
        action="review.delegation.created",
        actor_id=principal.id,
        org_id=scope.org_id,
        project_id=scope.project_id,
        payload={
            "delegation": row.id,
            "to": body.to_user_id,
            "starts_at": starts.isoformat(),
            "ends_at": ends.isoformat(),
        },
        request=request,
    )
    await db.commit()
    return _delegation_public(row, await _people(db, [row]))


@router.delete("/delegations/{delegation_id}")
async def revoke_delegation(
    delegation_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, str]:
    """End a lent approval now: its approver's, or a project administrator's."""
    principal = get_principal(request)
    row = await db.get(ApprovalDelegation, delegation_id)
    if row is None or row.project_id != scope.project_id or row.revoked_at:
        raise HTTPException(status_code=404, detail="Delegation not found")
    if row.from_user_id != principal.id and not principal.has("project.member.write"):
        raise HTTPException(status_code=403, detail="Only its approver ends it")
    row.revoked_at = datetime.now(UTC)
    await audit.record(
        db,
        action="review.delegation.revoked",
        actor_id=principal.id,
        org_id=scope.org_id,
        project_id=scope.project_id,
        payload={"delegation": row.id},
        request=request,
    )
    await db.commit()
    return {"revoked": row.id}


router.add_api_route("/cards/{card_id}/approve", approve_card, methods=["POST"])
router.add_api_route("/cards/{card_id}/approvals", card_approvals, methods=["GET"])
router.add_api_route("/cards/{card_id}/criticality", set_criticality, methods=["PUT"])
