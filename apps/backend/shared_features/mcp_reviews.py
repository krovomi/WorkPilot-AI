"""A server project team's security reviews of catalogue MCP servers (#369, lot 5).

The MCP Marketplace scores a server from what it can read (registry, OSV, the
published code); a review is what the team saw using it: "works, but sends
requests the docs do not mention". A member leaves one review per catalogue
server, and the project's members read them in the marketplace.

- **What is kept**: the catalogue id the review is about (checked against
  the id pattern; the catalogue ships with the app, not with the server), a
  verdict from a closed list (`VERDICTS`), and a comment of plain text,
  control characters and runs of spaces folded, `MAX_COMMENT` characters at
  most. It is shown as text and never handed to a model.
- **Who reaches it**: every route takes a ``project_id`` and resolves it
  (``resolve_project_scope``): another tenant's project answers 404, and a
  review never leaves its project. Reading is ``marketplace.read``; writing
  one's own review or deleting it is ``marketplace.write`` (contributor,
  reviewer and above). Deleting someone else's is the project owner's or an
  organization administrator's.
- **Bounds**: `MAX_REVIEWS` per project; a list answers `MAX_LISTED` at most.

Sharing reviews between organizations is not done: nothing leaves an
organization today.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel, ConfigDict, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import McpServerReview, ProjectRole
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/mcp-reviews", tags=["features"])

#: The verdicts a review may give, from the safest.
VERDICTS = ("safe", "caution", "unsafe")
#: A catalogue id, as `shared/mcp-catalog/install-policy.ts` names one.
SERVER_ID = r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
MAX_COMMENT = 1000
MAX_REVIEWS = 2000
MAX_LISTED = 500
_ID = r"^[0-9a-f-]{36}$"
_SPACES = re.compile(r"[ \t]+")
_NOT_FOUND = "review_not_found"


class ReviewIn(BaseModel):
    """The caller's review of one catalogue server."""

    model_config = ConfigDict(extra="forbid")

    server_id: str = Field(pattern=SERVER_ID)
    verdict: Literal["safe", "caution", "unsafe"]
    comment: str = Field(default="", max_length=MAX_COMMENT)


def clean_comment(text: str) -> str:
    """Plain text: control characters dropped (newlines kept), spaces folded."""
    kept = "".join(
        ch if ch == "\n" or (ch >= " " and ch != "\x7f") else " " for ch in text
    )
    lines = [_SPACES.sub(" ", line).strip() for line in kept.split("\n")]
    return "\n".join(lines).strip()[:MAX_COMMENT]


def _aware(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _iso(moment: datetime | None) -> str | None:
    aware = _aware(moment)
    return aware.isoformat() if aware else None


def _is_moderator(scope: ProjectScope, principal: Principal) -> bool:
    """The project's owner, or an organization administrator who reaches it
    without a membership row."""
    if scope.project_role is None:
        return principal.is_platform_admin or principal.has("project.member.write")
    return scope.project_role == ProjectRole.OWNER.value


def _public(
    row: McpServerReview, principal: Principal, scope: ProjectScope
) -> dict[str, Any]:
    mine = row.author_id is not None and row.author_id == principal.id
    return {
        "id": row.id,
        "server_id": row.server_id,
        "verdict": row.verdict,
        "comment": row.comment,
        "author": row.author_name,
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
        "mine": mine,
        "can_delete": mine or _is_moderator(scope, principal),
    }


@router.get("")
async def list_reviews(
    server_id: str | None = Query(default=None, pattern=SERVER_ID),
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The project's reviews, the latest first; of one server when named."""
    query = select(McpServerReview).where(
        McpServerReview.project_id == scope.project_id
    )
    if server_id is not None:
        query = query.where(McpServerReview.server_id == server_id)
    rows = await db.scalars(
        query.order_by(McpServerReview.updated_at.desc()).limit(MAX_LISTED)
    )
    return {"reviews": [_public(row, principal, scope) for row in rows.all()]}


@router.put("")
async def put_review(
    body: ReviewIn,
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Write the caller's review of a server, replacing the one they left."""
    now = datetime.now(UTC)
    row = await db.scalar(
        select(McpServerReview).where(
            McpServerReview.project_id == scope.project_id,
            McpServerReview.server_id == body.server_id,
            McpServerReview.author_id == principal.id,
        )
    )
    if row is None:
        count = await db.scalar(
            select(func.count())
            .select_from(McpServerReview)
            .where(McpServerReview.project_id == scope.project_id)
        )
        if (count or 0) >= MAX_REVIEWS:
            raise HTTPException(status_code=422, detail="too_many_reviews")
        row = McpServerReview(
            project_id=scope.project_id,
            server_id=body.server_id,
            author_id=principal.id,
            created_at=now,
        )
        db.add(row)
    row.author_name = (principal.display_name or principal.email)[:200]
    row.verdict = body.verdict
    row.comment = clean_comment(body.comment)
    row.updated_at = now
    await db.commit()
    return {"review": _public(row, principal, scope)}


@router.delete("/{review_id}")
async def delete_review(
    review_id: str = Path(pattern=_ID),
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    """Remove a review: its author's, or the project owner's, to do."""
    row = await db.get(McpServerReview, review_id)
    if row is None or row.project_id != scope.project_id:
        raise HTTPException(status_code=404, detail=_NOT_FOUND)
    if row.author_id != principal.id and not _is_moderator(scope, principal):
        raise HTTPException(
            status_code=403,
            detail="Only its author or the project owner can delete it",
        )
    await db.delete(row)
    await db.commit()
    return {"deleted": True}
