"""Team links seen from above (#347): the person's own links on every project
of the server, and a project's usage figures.

- **Mine** (``GET /mine``): the links the caller made, on every project of
  the organization they act in that they still reach, so that they can be
  revoked from the app's Settings rather than one share dialog at a time.
  Each project is authorized again through ``load_project_scope``, the same
  gate as a route that takes a ``project_id``: a project the person left is
  not listed. Revoking goes through ``DELETE /{share_id}`` with that
  project's id, which checks the author again.
- **Usage** (``GET /usage``): what one project's team does with its links
  over the last four weeks, as aggregates only (counts and ratios, never a
  title, a person or a link). Four weeks because every share made in that
  window is still kept: one is forgotten 30 days after it ended
  (``KEEP_ENDED``). It is computed on this server, from its own database,
  and sent nowhere else; the app counts the rest on the machine
  (``replay/usage.py``).

Both are ``lab.read`` (the router is mounted as ``replay_shares``).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, load_project_scope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import Project, ReplayShare
from shared_features.replay_shares import MAX_LISTED, _aware, _public, _state
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

router = APIRouter(prefix="/api/features/replay-shares", tags=["features"])

USAGE_WEEKS = 4
WEEK = timedelta(days=7)


def _ratio(part: int, whole: int) -> float | None:
    return round(part / whole, 4) if whole else None


@router.get("/mine")
async def my_shares(
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The caller's own links, on every project they still reach, latest first."""
    if principal.is_local:
        raise HTTPException(status_code=400, detail="server mode only")
    rows = (
        await db.execute(
            select(ReplayShare, Project.name)
            .options(defer(ReplayShare.bundle))
            .join(Project, Project.id == ReplayShare.project_id)
            .where(
                ReplayShare.created_by == principal.id,
                Project.org_id == principal.org_id,
            )
            .order_by(ReplayShare.created_at.desc())
            .limit(MAX_LISTED)
        )
    ).all()
    scopes: dict[str, ProjectScope | None] = {}
    for share, _name in rows:
        if share.project_id in scopes:
            continue
        try:
            scopes[share.project_id] = await load_project_scope(
                db, principal, share.project_id
            )
        except HTTPException:
            scopes[share.project_id] = None
    now = datetime.now(UTC)
    listed = []
    for share, name in rows:
        scope = scopes[share.project_id]
        if scope is None:
            continue
        item = _public(share, principal, scope, now)
        item.update(project_id=share.project_id, project_name=name)
        listed.append(item)
    return {"shares": listed}


@router.get("/usage")
async def project_usage(
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """A project's team links over the last four weeks, as aggregates."""
    rows = (
        await db.scalars(
            select(ReplayShare)
            .options(defer(ReplayShare.bundle))
            .where(ReplayShare.project_id == scope.project_id)
        )
    ).all()
    now = datetime.now(UTC)
    start = now - USAGE_WEEKS * WEEK
    weeks = [
        {
            "start": (start + i * WEEK).isoformat(),
            "end": (start + (i + 1) * WEEK).isoformat(),
            "created": 0,
            "opened": 0,
        }
        for i in range(USAGE_WEEKS)
    ]
    links = opened = opens = annotated = known = 0
    sharers: set[str] = set()
    active = 0
    for row in rows:
        if _state(row, now) == "active":
            active += 1
        created = _aware(row.created_at)
        if created is None or not start <= created < now:
            continue
        week = weeks[min(int((created - start) / WEEK), USAGE_WEEKS - 1)]
        week["created"] += 1
        links += 1
        if row.open_count:
            week["opened"] += 1
            opened += 1
            opens += row.open_count
        if row.bookmarks is not None:
            known += 1
            annotated += 1 if row.bookmarks > 0 else 0
        if row.created_by:
            sharers.add(row.created_by)
    return {
        "window_days": USAGE_WEEKS * 7,
        "weeks": weeks,
        "links": links,
        "opened_links": opened,
        "open_rate": _ratio(opened, links),
        "opens": opens,
        "active": active,
        "annotated": annotated,
        "annotated_ratio": _ratio(annotated, known),
        "sharers": len(sharers),
    }
