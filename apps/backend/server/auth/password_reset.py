"""Setting a new local password when the old one is lost.

Two ways in, one way out:

- the person asks with their address (:func:`request_reset`): if it names an
  active account with a local password, a link goes to that address. The
  answer never says whether it did, so the route cannot be used to learn
  which addresses have an account;
- a platform admin issues a link for an account (:func:`issue_reset`), sent
  by email or handed over when the server has no SMTP. A platform admin, not
  an organization admin: an account can belong to several organizations, and
  an admin of one must not be able to take it over in the others;
- the link's token and a new password set the password
  (:func:`confirm_reset`), close every other link of the account and revoke
  all its sessions, as a password change does.

As for invitations, the raw token (256 bits, urlsafe) is never stored, only
its SHA-256 hash; a link serves once and expires after
``WORKPILOT_PASSWORD_RESET_TTL_MINUTES`` (60 by default, 5 to 1440).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from server.auth.invitations import generate_token, hash_token
from server.auth.local import LocalAuthError, _validate_password, hash_password
from server.config import get_settings
from server.db.models import (
    AuditLog,
    IdentityProvider,
    PasswordReset,
    User,
    UserIdentity,
)
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

#: The bounds of the link's lifetime, whatever the setting says.
MIN_TTL_MINUTES = 5
MAX_TTL_MINUTES = 24 * 60

#: A second request for the same account within this delay sends nothing:
#: one address cannot be flooded with emails.
REQUEST_COOLDOWN = timedelta(minutes=1)


class PasswordResetError(Exception):
    """The link is unknown, used, expired, or its account cannot reset."""


@dataclass(frozen=True)
class IssuedReset:
    """A link just issued: its token is in this object only."""

    user: User
    token: str
    expires_at: datetime


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime) -> datetime:
    # SQLite returns naive datetimes; treat them as UTC.
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def ttl() -> timedelta:
    minutes = get_settings().password_reset_ttl_minutes
    return timedelta(minutes=min(max(minutes, MIN_TTL_MINUTES), MAX_TTL_MINUTES))


def build_reset_link(token: str) -> str:
    """The link to paste in the app, or a bare ``?token=`` fragment."""
    base = get_settings().public_base_url
    return (
        f"{base}/reset-password?token={token}"
        if base
        else f"/reset-password?token={token}"
    )


async def _local_identity(db: AsyncSession, user_id: str) -> UserIdentity | None:
    identity = await db.scalar(
        select(UserIdentity).where(
            UserIdentity.user_id == user_id,
            UserIdentity.provider == IdentityProvider.LOCAL.value,
        )
    )
    if identity is None or not identity.password_hash:
        return None
    return identity


async def _close_live(db: AsyncSession, user_id: str, now: datetime) -> None:
    await db.execute(
        update(PasswordReset)
        .where(PasswordReset.user_id == user_id, PasswordReset.used_at.is_(None))
        .values(used_at=now)
    )


async def issue_reset(
    db: AsyncSession, user: User, *, created_by: str | None
) -> IssuedReset:
    """A new link for ``user``, closing the earlier ones; committed.

    The caller records who asked for it in the same transaction.

    Raises :class:`PasswordResetError` for a disabled account or one that
    signs in only with an identity provider.
    """
    if not user.is_active:
        raise PasswordResetError("This account is disabled")
    if await _local_identity(db, user.id) is None:
        raise PasswordResetError("This account has no local password")
    now = _utcnow()
    await _close_live(db, user.id, now)
    token = generate_token()
    expires_at = now + ttl()
    db.add(
        PasswordReset(
            user_id=user.id,
            token_hash=hash_token(token),
            created_by=created_by,
            expires_at=expires_at,
            created_at=now,
        )
    )
    # The caller's audit entry, added before, goes in the same commit.
    await db.commit()
    return IssuedReset(user=user, token=token, expires_at=expires_at)


async def request_reset(
    db: AsyncSession, email: str, *, ip: str | None = None
) -> IssuedReset | None:
    """A link for the account of ``email``, or None when there is none to send.

    None covers every case the caller must not tell apart: no such address,
    a disabled account, an account without a local password, and a request
    made a moment ago.
    """
    address = email.strip().lower()
    identity = await db.scalar(
        select(UserIdentity).where(
            UserIdentity.provider == IdentityProvider.LOCAL.value,
            UserIdentity.subject == address,
        )
    )
    if identity is None or not identity.password_hash:
        return None
    user = await db.get(User, identity.user_id)
    if user is None or not user.is_active:
        return None
    last = await db.scalar(
        select(PasswordReset.created_at)
        .where(PasswordReset.user_id == user.id, PasswordReset.created_by.is_(None))
        .order_by(PasswordReset.created_at.desc())
        .limit(1)
    )
    if last is not None and _utcnow() - _aware(last) < REQUEST_COOLDOWN:
        return None
    db.add(
        AuditLog(
            user_id=user.id,
            action="auth.password_reset.requested",
            payload={"user_id": user.id},
            ip=ip,
        )
    )
    return await issue_reset(db, user, created_by=None)


async def _live_reset(db: AsyncSession, token: str) -> PasswordReset:
    row = await db.scalar(
        select(PasswordReset).where(PasswordReset.token_hash == hash_token(token))
    )
    if row is None or row.used_at is not None or _aware(row.expires_at) <= _utcnow():
        raise PasswordResetError("This reset link is invalid or has expired")
    return row


async def lookup_reset(db: AsyncSession, token: str) -> str:
    """The address a live link is for, to show before choosing a password."""
    row = await _live_reset(db, token)
    user = await db.get(User, row.user_id)
    if user is None or not user.is_active:
        raise PasswordResetError("This reset link is invalid or has expired")
    return user.email


async def confirm_reset(
    db: AsyncSession, token: str, new_password: str, *, ip: str | None = None
) -> User:
    """Set ``new_password`` with the link's ``token``; committed.

    Raises :class:`PasswordResetError` for a link that cannot serve, and
    :class:`~server.auth.local.LocalAuthError` for a password the policy
    refuses (the link is then left usable).
    """
    row = await _live_reset(db, token)
    user = await db.get(User, row.user_id)
    identity = await _local_identity(db, row.user_id)
    if user is None or not user.is_active or identity is None:
        raise PasswordResetError("This reset link is invalid or has expired")
    _validate_password(new_password, email=user.email)
    identity.password_hash = hash_password(new_password)
    now = _utcnow()
    await _close_live(db, user.id, now)
    # Whoever held the account's sessions must sign in again, with the new
    # password: the same rule as a password change.
    from server.auth.jwt_tokens import revoke_all_sessions

    await revoke_all_sessions(db, user.id, commit=False)
    db.add(
        AuditLog(
            user_id=user.id,
            action="auth.password_reset.completed",
            payload={"user_id": user.id},
            ip=ip,
        )
    )
    await db.commit()
    logger.info("Password reset completed for user %s", user.id)
    return user


__all__ = [
    "IssuedReset",
    "LocalAuthError",
    "PasswordResetError",
    "build_reset_link",
    "confirm_reset",
    "issue_reset",
    "lookup_reset",
    "request_reset",
    "ttl",
]
