"""Personal access tokens: an AI app's key to the board's MCP endpoint.

A person makes one in the app (Settings, Integrations, MCP access) for the
organization they act in, and pastes it into Claude Code, Codex, Cursor...
The token is ``wpat_`` and 43 random URL-safe characters; only its SHA-256
hash is stored, with its first characters to tell it apart in a list.

What a token is not:

- **Not a session.** It opens ``/mcp`` only: the auth middleware never reads
  one (``server/integration.py`` refuses anything that is not a signed access
  token), so a token pasted in an AI app's config cannot call the REST API,
  make another token, or change a password.
- **Not a frozen grant.** Each use re-reads the person (still active), their
  membership of the token's organization, and their permissions there, as a
  request with an access token does. A person removed from the organization,
  or whose role lost ``task.read``, loses the token's reach at once.
- **Not wider than its scope.** A ``read`` token lists and reads; only a
  ``write`` token creates or edits a card, and only where the person's own
  role lets them.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from server.authz.principal import Principal
from server.db.models import AccessToken, User
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

TOKEN_PREFIX = "wpat_"
SCOPES = ("read", "write")
DEFAULT_TTL_DAYS = 90
MAX_TTL_DAYS = 365
MAX_TOKENS_PER_USER = 20
#: A use updates ``last_used_at`` at most this often (one write per minute,
#: not one per tool call).
LAST_USED_RESOLUTION = timedelta(minutes=1)


class AccessTokenError(Exception):
    """Unknown, revoked or expired token, or its owner can no longer use it."""


@dataclass(frozen=True)
class TokenUse:
    token: AccessToken
    principal: Principal


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def new_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def looks_like_token(raw: str) -> bool:
    return raw.startswith(TOKEN_PREFIX) and 20 <= len(raw) <= 100


async def create_token(
    db: AsyncSession,
    *,
    user_id: str,
    org_id: str,
    name: str,
    scope: str,
    ttl_days: int = DEFAULT_TTL_DAYS,
) -> tuple[AccessToken, str]:
    """A new token row and the token itself, which is shown once and never again."""
    if scope not in SCOPES:
        raise ValueError(f"scope must be one of {', '.join(SCOPES)}")
    if not 1 <= ttl_days <= MAX_TTL_DAYS:
        raise ValueError(f"a token lasts between 1 and {MAX_TTL_DAYS} days")
    live = await live_tokens(db, user_id)
    if len(live) >= MAX_TOKENS_PER_USER:
        raise ValueError(f"at most {MAX_TOKENS_PER_USER} tokens; revoke one first")
    raw = new_token()
    row = AccessToken(
        user_id=user_id,
        org_id=org_id,
        name=" ".join(name.split())[:80] or "MCP",
        token_hash=hash_token(raw),
        prefix=raw[: len(TOKEN_PREFIX) + 6],
        scope=scope,
        expires_at=_utcnow() + timedelta(days=ttl_days),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row, raw


async def live_tokens(db: AsyncSession, user_id: str) -> list[AccessToken]:
    rows = await db.scalars(
        select(AccessToken)
        .where(AccessToken.user_id == user_id, AccessToken.revoked_at.is_(None))
        .order_by(AccessToken.created_at.desc())
    )
    now = _utcnow()
    return [row for row in rows if _aware(row.expires_at) > now]


async def revoke_token(db: AsyncSession, user_id: str, token_id: str) -> bool:
    """Revoke one of the person's own tokens. False when they have none of that id."""
    row = await db.get(AccessToken, token_id)
    if row is None or row.user_id != user_id or row.revoked_at is not None:
        return False
    row.revoked_at = _utcnow()
    await db.commit()
    return True


async def authenticate(db: AsyncSession, raw: str) -> TokenUse:
    """The token's row and the principal it acts as, checked now."""
    from server.authz.engine import resolve_permissions
    from server.authz.tenancy import can_act_in

    if not looks_like_token(raw):
        raise AccessTokenError("not an access token")
    row = await db.scalar(
        select(AccessToken).where(AccessToken.token_hash == hash_token(raw))
    )
    now = _utcnow()
    if row is None or row.revoked_at is not None or _aware(row.expires_at) <= now:
        raise AccessTokenError("unknown, revoked or expired token")
    user = await db.get(User, row.user_id)
    if user is None or not user.is_active:
        raise AccessTokenError("the token's owner is disabled")
    if not await can_act_in(db, user.id, user.role, row.org_id):
        raise AccessTokenError("the token's owner left its organization")
    permissions, org_role_slug = await resolve_permissions(
        db, user_id=user.id, platform_role=user.role, org_id=row.org_id
    )
    if (
        row.last_used_at is None
        or now - _aware(row.last_used_at) > LAST_USED_RESOLUTION
    ):
        row.last_used_at = now
        await db.commit()
    principal = Principal(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        platform_role=user.role,
        org_id=row.org_id,
        org_role_slug=org_role_slug,
        permissions=permissions,
    )
    return TokenUse(token=row, principal=principal)
