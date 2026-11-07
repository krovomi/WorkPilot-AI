"""A person's MCP access tokens: list them, make one, revoke one.

``/users/me/access-tokens``. A token is made for the organization the person
acts in (the ``X-Org-Id`` of the request), shown once in the answer, and
listed afterwards by its name, prefix, scope and dates only. These routes
take an access token, never a personal one: an AI app holding a personal
token cannot make itself another (``server/auth/access_tokens.py``).
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from server.auth.access_tokens import (
    DEFAULT_TTL_DAYS,
    MAX_TTL_DAYS,
    create_token,
    live_tokens,
    revoke_token,
)
from server.auth.deps import CurrentUser, get_current_user
from server.authz.principal import get_principal
from server.db.engine import get_db
from server.db.models import AccessToken
from server.services import audit
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users/me/access-tokens", tags=["users"])


class TokenCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    scope: Literal["read", "write"] = "read"
    ttl_days: int = Field(default=DEFAULT_TTL_DAYS, ge=1, le=MAX_TTL_DAYS)


class TokenPublic(BaseModel):
    id: str
    name: str
    prefix: str
    scope: str
    org_id: str
    created_at: datetime
    expires_at: datetime
    last_used_at: datetime | None


class TokenCreated(TokenPublic):
    #: The token itself: in this answer only.
    token: str


def _public(row: AccessToken) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "prefix": row.prefix,
        "scope": row.scope,
        "org_id": row.org_id,
        "created_at": row.created_at,
        "expires_at": row.expires_at,
        "last_used_at": row.last_used_at,
    }


@router.get("", response_model=list[TokenPublic])
async def list_tokens(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[dict]:
    return [_public(row) for row in await live_tokens(db, user.id)]


@router.post("", response_model=TokenCreated, status_code=201)
async def make_token(
    body: TokenCreate,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    principal = get_principal(request)
    if principal.org_id is None:
        raise HTTPException(status_code=400, detail="Pick an organization first")
    if not principal.has("task.read"):
        # A token that could not read a single board would only be a key to
        # nothing; refusing says why up front.
        raise HTTPException(status_code=403, detail="Missing permission: task.read")
    try:
        row, raw = await create_token(
            db,
            user_id=user.id,
            org_id=principal.org_id,
            name=body.name,
            scope=body.scope,
            ttl_days=body.ttl_days,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    await audit.record(
        db,
        action="access_token.create",
        actor_id=user.id,
        org_id=principal.org_id,
        payload={"token_id": row.id, "scope": row.scope, "name": row.name},
        request=request,
        commit=True,
    )
    return {**_public(row), "token": raw}


@router.delete("/{token_id}")
async def delete_token(
    token_id: str,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not await revoke_token(db, user.id, token_id):
        raise HTTPException(status_code=404, detail="Token not found")
    await audit.record(
        db,
        action="access_token.revoke",
        actor_id=user.id,
        org_id=getattr(request.state, "org_id", None),
        payload={"token_id": token_id},
        request=request,
        commit=True,
    )
    return {"revoked": True}
