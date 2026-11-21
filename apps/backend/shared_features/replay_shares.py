"""Team links to a recorded agent session, kept by the server (#347).

On the desktop a replay is a file of the machine (``~/.workpilot/replays``):
sharing it meant sending a ``.wpreplay`` by hand. A member of a server project
can now leave one with the project instead, and get a link to it that lasts
a few days (``ttl_days``, 7 by default, 30 at most) and that its author or
the project's owner can revoke.

- **What is kept** is the bundle the sharer's app built, already masked on
  that machine (``replay/bundle.py``). The server reads it back once, through
  the same bounded decoder and rebuilder as an import, so that what it keeps
  is a bundle the app can open, and takes its title and step count from it.
  Nothing in it runs here.
- **The link** carries an id and a random token (32 bytes). The server keeps
  only the token's SHA-256, so a copy of the database cannot rebuild a link;
  the token travels in the body of the request that opens the share, never
  in a URL the server or a proxy would log.
- **Who reaches it**: every route takes a ``project_id`` and resolves it
  (``resolve_project_scope``), so another tenant's share answers 404. Reading
  the list and opening a share is ``lab.read``, any role on the project, and
  the token; leaving one is ``lab.write`` and the role ``member``; revoking
  is its author's or the project owner's. A revoked or expired share answers
  410 and its bundle is dropped from the database.

How many times each link was opened is counted: the app shows it beside the
link, which is how the team sees whether its shares are read.
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import hmac
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import ProjectRole, ReplayShare
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/replay-shares", tags=["features"])

#: A shared bundle is at most this large (gzip), under the 25 MB of a file.
MAX_SHARED_BYTES = 10 * 1024 * 1024
#: Shares a project keeps that still open, at most.
MAX_ACTIVE_SHARES = 200
MAX_LISTED = 200
DEFAULT_TTL_DAYS = 7
MAX_TTL_DAYS = 30
#: A share that ended is dropped from the list this long after.
KEEP_ENDED = timedelta(days=30)
MAX_TITLE = 200
TOKEN_BYTES = 32

_ID = r"^[0-9a-f-]{36}$"
_WRITER_ROLES = {ProjectRole.MEMBER.value, ProjectRole.OWNER.value}
_UNAVAILABLE = "share_not_found"


class CreateShareRequest(BaseModel):
    # base64 of the bundle: 4 characters for every 3 bytes, plus padding
    content_base64: str = Field(max_length=(MAX_SHARED_BYTES // 3 + 1) * 4)
    ttl_days: int = Field(default=DEFAULT_TTL_DAYS, ge=1, le=MAX_TTL_DAYS)


class OpenShareRequest(BaseModel):
    token: str = Field(min_length=1, max_length=128)


def _aware(moment: datetime | None) -> datetime | None:
    """A timestamp of the database in UTC (SQLite gives them back naive)."""
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _iso(moment: datetime | None) -> str | None:
    aware = _aware(moment)
    return aware.isoformat() if aware else None


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _is_manager(scope: ProjectScope, principal: Principal) -> bool:
    """The project's owner, or an organization administrator who reaches it
    without a membership row."""
    if scope.project_role is None:
        return principal.is_platform_admin or principal.has("project.member.write")
    return scope.project_role == ProjectRole.OWNER.value


def _require_writer(scope: ProjectScope, principal: Principal) -> None:
    if scope.project_role in _WRITER_ROLES or (
        scope.project_role is None and _is_manager(scope, principal)
    ):
        return
    raise HTTPException(status_code=403, detail="Requires project role 'member'")


def _state(row: ReplayShare, now: datetime) -> str:
    if row.revoked_at is not None:
        return "revoked"
    expires = _aware(row.expires_at)
    return "expired" if expires is not None and expires <= now else "active"


def _public(
    row: ReplayShare, principal: Principal, scope: ProjectScope, now: datetime
) -> dict[str, Any]:
    """A share as the list shows it: never its token, never its bundle."""
    return {
        "id": row.id,
        "title": row.title,
        "steps": row.steps,
        "size_bytes": row.size_bytes,
        "created_by": row.created_by_name,
        "created_at": _iso(row.created_at),
        "expires_at": _iso(row.expires_at),
        "state": _state(row, now),
        "open_count": row.open_count,
        "last_opened_at": _iso(row.last_opened_at),
        "can_revoke": row.created_by == principal.id or _is_manager(scope, principal),
    }


def _read_bundle(content_base64: str) -> tuple[bytes, str, int]:
    """The bundle's bytes, its title and its step count; 422 when the bytes
    are not a bundle the app could import."""
    from replay.bundle import BundleError, decode, session_from_bundle

    try:
        data = base64.b64decode(content_base64, validate=True)
    except binascii.Error as error:
        raise HTTPException(status_code=422, detail="unreadable") from error
    if len(data) > MAX_SHARED_BYTES:
        raise HTTPException(status_code=422, detail="too_large")
    try:
        session = session_from_bundle(decode(data))
    except BundleError as error:
        raise HTTPException(status_code=422, detail=error.args[0]) from error
    task = " ".join(session.task_description.split())
    title = session.agent_name or "session"
    if task:
        title = f"{title}: {task}"
    return data, title[:MAX_TITLE], len(session.steps)


async def _forget_ended(db: AsyncSession, project_id: str, now: datetime) -> None:
    """Drop the project's shares that ended more than ``KEEP_ENDED`` ago."""
    cutoff = now - KEEP_ENDED
    await db.execute(
        delete(ReplayShare).where(
            ReplayShare.project_id == project_id,
            ReplayShare.expires_at < cutoff,
        )
    )
    await db.execute(
        delete(ReplayShare).where(
            ReplayShare.project_id == project_id,
            ReplayShare.revoked_at.is_not(None),
            ReplayShare.revoked_at < cutoff,
        )
    )


async def _share_or_404(
    db: AsyncSession, scope: ProjectScope, share_id: str
) -> ReplayShare:
    row = await db.get(ReplayShare, share_id)
    if row is None or row.project_id != scope.project_id:
        raise HTTPException(status_code=404, detail=_UNAVAILABLE)
    return row


@router.post("")
async def create_share(
    req: CreateShareRequest,
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Keep a bundle with the project; answers the link's token, once."""
    _require_writer(scope, principal)
    data, title, steps = await asyncio.to_thread(_read_bundle, req.content_base64)
    now = datetime.now(UTC)
    await _forget_ended(db, scope.project_id, now)
    active = await db.scalar(
        select(func.count())
        .select_from(ReplayShare)
        .where(
            ReplayShare.project_id == scope.project_id,
            ReplayShare.revoked_at.is_(None),
            ReplayShare.expires_at > now,
        )
    )
    if (active or 0) >= MAX_ACTIVE_SHARES:
        raise HTTPException(status_code=422, detail="too_many_shares")
    token = secrets.token_urlsafe(TOKEN_BYTES)
    row = ReplayShare(
        project_id=scope.project_id,
        created_by=principal.id,
        created_by_name=(principal.display_name or principal.email)[:200],
        title=title,
        steps=steps,
        size_bytes=len(data),
        bundle=data,
        token_hash=_hash(token),
        created_at=now,
        expires_at=now + timedelta(days=req.ttl_days),
        open_count=0,
    )
    db.add(row)
    await db.commit()
    return {"share": _public(row, principal, scope, now), "token": token}


@router.get("")
async def list_shares(
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The project's shares, the latest first, without their tokens."""
    rows = await db.scalars(
        select(ReplayShare)
        .where(ReplayShare.project_id == scope.project_id)
        .order_by(ReplayShare.created_at.desc())
        .limit(MAX_LISTED)
    )
    now = datetime.now(UTC)
    return {"shares": [_public(row, principal, scope, now) for row in rows.all()]}


@router.post("/{share_id}/open")
async def open_share(
    req: OpenShareRequest,
    share_id: str = Path(pattern=_ID),
    scope: ProjectScope = Depends(resolve_project_scope),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The bundle of a share, for the holder of its link's token."""
    row = await _share_or_404(db, scope, share_id)
    if not hmac.compare_digest(row.token_hash, _hash(req.token)):
        raise HTTPException(status_code=404, detail=_UNAVAILABLE)
    now = datetime.now(UTC)
    state = _state(row, now)
    if state != "active":
        raise HTTPException(status_code=410, detail=f"share_{state}")
    row.open_count = (row.open_count or 0) + 1
    row.last_opened_at = now
    content = base64.b64encode(row.bundle).decode("ascii")
    title = row.title
    await db.commit()
    return {"title": title, "content_base64": content}


@router.delete("/{share_id}")
async def revoke_share(
    share_id: str = Path(pattern=_ID),
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """End a share now: its author's, or the project owner's, to do."""
    row = await _share_or_404(db, scope, share_id)
    if row.created_by != principal.id and not _is_manager(scope, principal):
        raise HTTPException(
            status_code=403, detail="Only its author or the project owner can revoke it"
        )
    if row.revoked_at is None:
        row.revoked_at = datetime.now(UTC)
    row.bundle = b""
    await db.commit()
    return {"revoked": True}
