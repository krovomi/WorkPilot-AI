"""Cards of a shared board, in server mode: create, read, edit, delete, approve.

A server-mode project is a clone on the server, and its board is that clone's
``.workpilot/specs/``, the same files the desktop app and the agents read. The
server's own routes (``server/routers/specs.py``) index those cards, claim them
and start runs on them; these routes change the cards themselves, with the
writers the pipeline already uses: the board's card writer
(``board_mcp.server.write_card``, numbered under the board's lock) and the
review state the build checks before it starts (``review.state.ReviewState``).
The server package imports nothing from the backend, so they live here.

Every route takes a ``project_id``, never a path, and resolves it through
``server.authz.scope.resolve_project_scope``: the project must be the
caller's tenant's, and the caller one of its members. On top of the
permission the mount derives (``task.read`` / ``task.write``, ``task.delete``
and ``review.approve`` for the two routes raised in ``ROUTE_OVERRIDES``),
changing a card needs a project role of ``member`` or more; a ``viewer`` reads.

A card's text is what a person wrote. It is stored and shown as such; the
agents that later read it get it through the pipeline's own handling of the
task description, never as an instruction to this server.
"""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project, ProjectRole, SpecIndex
from server.services.events import emit_board_event
from server.services.spec_indexer import reindex_project
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/board", tags=["board"])

MAX_TITLE = 200
MAX_DESCRIPTION = 20_000
SPEC_TEXT_LIMIT = 100_000

_WRITER_ROLES = {ProjectRole.MEMBER.value, ProjectRole.OWNER.value}


class CardCreate(BaseModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE)
    description: str = Field(default="", max_length=MAX_DESCRIPTION)
    kind: str | None = None
    # As on the desktop card: when true, the build waits for someone to
    # approve the spec and plan; when false, spec creation approves them.
    require_review: bool = True


class CardUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=MAX_TITLE)
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION)


def _require_writer(scope: ProjectScope, principal: Principal) -> None:
    # An organization administrator reaches a project without a membership
    # row (``project_role`` is None); everyone else needs member or owner.
    if scope.project_role is None:
        if principal.is_platform_admin or principal.has("project.member.write"):
            return
    elif scope.project_role in _WRITER_ROLES:
        return
    raise HTTPException(status_code=403, detail="Requires project role 'member'")


def _card_or_404(scope: ProjectScope, card_id: str) -> Path:
    from board_mcp.server import card_dir

    directory = card_dir(scope.path, card_id)
    if directory is None:
        raise HTTPException(status_code=404, detail="Card not found")
    return directory


def _started(scope: ProjectScope, directory: Path) -> bool:
    """Whether work began: a spec was written or a build workspace exists."""
    worktree = scope.path / ".workpilot" / "worktrees" / "tasks" / directory.name
    return (directory / "spec.md").exists() or worktree.exists()


def _read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")


async def _index_row(
    db: AsyncSession, scope: ProjectScope, card_id: str
) -> SpecIndex | None:
    project = await db.get(Project, scope.project_id)
    if project is not None:
        await reindex_project(db, project)
    return await db.scalar(
        select(SpecIndex).where(
            SpecIndex.project_id == scope.project_id, SpecIndex.spec_name == card_id
        )
    )


@router.post("/cards", status_code=201)
async def create_card(
    body: CardCreate,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from board_mcp.server import KINDS, summary, write_card
    from core.workspace.models import SpecNumberLockError

    principal = get_principal(request)
    _require_writer(scope, principal)
    if body.kind is not None and body.kind not in KINDS:
        raise HTTPException(status_code=422, detail=f"kind must be one of {KINDS}")

    title = " ".join(body.title.split())
    metadata: dict[str, Any] = {
        "sourceType": "server",
        "createdBy": principal.id,
        "requireReviewBeforeCoding": body.require_review,
    }
    if body.kind:
        metadata.update(kind=body.kind, kindSource="user", kindConfidence=1)
    try:
        directory = write_card(
            scope.path, title, body.description.strip() or title, metadata
        )
    except SpecNumberLockError as e:
        raise HTTPException(status_code=409, detail="Board busy, try again") from e

    row = await _index_row(db, scope, directory.name)
    if row is not None and row.created_by is None:
        row.created_by = principal.id
        await db.commit()
    card = summary(directory)
    emit_board_event(
        scope.project_id, "spec_created", {"spec": directory.name, "by": principal.id}
    )
    return {**card, "specId": row.id if row else None}


@router.get("/cards/{card_id}")
async def get_card(
    card_id: str,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    from board_mcp.server import details
    from review.state import ReviewState

    directory = _card_or_404(scope, card_id)
    card = details(directory)
    spec = directory / "spec.md"
    card["spec"] = (
        spec.read_text(encoding="utf-8")[:SPEC_TEXT_LIMIT] if spec.is_file() else None
    )
    review = ReviewState.load(directory)
    card["approval"] = {
        "approved": review.is_approval_valid(directory),
        "approvedBy": review.approved_by or None,
        "approvedAt": review.approved_at or None,
    }
    card["requireReview"] = bool(
        _read_json(directory / "task_metadata.json").get(
            "requireReviewBeforeCoding", True
        )
    )
    return card


@router.patch("/cards/{card_id}")
async def update_card(
    card_id: str,
    body: CardUpdate,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    from board_mcp.server import summary

    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    if _started(scope, directory):
        # The spec and the plan were written from this text; editing it now
        # would leave the card saying one thing and the build doing another.
        raise HTTPException(
            status_code=409, detail="Work has started on this card; it cannot be edited"
        )

    plan_path = directory / "implementation_plan.json"
    requirements_path = directory / "requirements.json"
    plan = _read_json(plan_path)
    requirements = _read_json(requirements_path)
    if body.title is not None:
        plan["feature"] = " ".join(body.title.split())
    if body.description is not None:
        text = body.description.strip() or plan.get("feature") or card_id
        plan["description"] = text
        requirements["task_description"] = text
    plan["updated_at"] = datetime.now(UTC).isoformat()
    _write_json(plan_path, plan)
    _write_json(requirements_path, requirements)

    emit_board_event(
        scope.project_id, "spec_updated", {"spec": card_id, "by": principal.id}
    )
    return summary(directory)


@router.delete("/cards/{card_id}")
async def delete_card(
    card_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    from server.services.run_manager import get_run_manager

    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    row = await _index_row(db, scope, card_id)
    if row is not None:
        if get_run_manager().is_running(row.id):
            raise HTTPException(status_code=409, detail="A run is active on this card")
        if (
            row.claimed_by
            and row.claimed_by != principal.id
            and scope.project_role != ProjectRole.OWNER.value
            and not principal.is_platform_admin
        ):
            raise HTTPException(status_code=409, detail="Claimed by someone else")
    worktree = scope.path / ".workpilot" / "worktrees" / "tasks" / card_id
    if worktree.exists():
        raise HTTPException(
            status_code=409, detail="Discard the card's build workspace first"
        )

    shutil.rmtree(directory)
    await _index_row(db, scope, card_id)
    emit_board_event(
        scope.project_id, "spec_deleted", {"spec": card_id, "by": principal.id}
    )
    return {"deleted": card_id}


@router.post("/cards/{card_id}/approve")
async def approve_card(
    card_id: str,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """Approve the card's spec and plan, so a build may start on them.

    The approval is the one the build checks (``review_state.json``, with the
    hash of ``spec.md`` and the plan): editing either afterwards voids it.
    """
    from review.state import ReviewState

    principal = get_principal(request)
    _require_writer(scope, principal)
    directory = _card_or_404(scope, card_id)
    if not (directory / "spec.md").is_file():
        raise HTTPException(status_code=409, detail="No spec to approve yet")

    review = ReviewState.load(directory)
    review.approve(directory, approved_by=principal.email or principal.id)
    emit_board_event(
        scope.project_id, "spec_approved", {"spec": card_id, "by": principal.id}
    )
    return {"approved": True, "approvedBy": review.approved_by}
