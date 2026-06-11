"""Local accounts: email + password (argon2id).

Local accounts are the fallback/admin path; employees normally sign in
through Entra ID. Registration is admin-only (no self-service signup).
"""

from __future__ import annotations

import logging

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, VerifyMismatchError
from server.db.models import GlobalRole, IdentityProvider, User, UserIdentity
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

logger = logging.getLogger(__name__)

_hasher = PasswordHasher()  # argon2id with library defaults

MIN_PASSWORD_LENGTH = 10


class LocalAuthError(Exception):
    pass


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerifyMismatchError, VerificationError):
        return False


def _validate_password(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise LocalAuthError(
            f"Password must be at least {MIN_PASSWORD_LENGTH} characters"
        )


async def create_local_user(
    db: AsyncSession,
    email: str,
    password: str,
    display_name: str,
    role: str = GlobalRole.MEMBER.value,
) -> User:
    """Create a user with a local-password identity (admin action)."""
    _validate_password(password)
    email = email.strip().lower()
    if not email or "@" not in email:
        raise LocalAuthError("Invalid email address")

    existing = await db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise LocalAuthError("A user with this email already exists")

    user = User(email=email, display_name=display_name.strip() or email, role=role)
    db.add(user)
    await db.flush()
    db.add(
        UserIdentity(
            user_id=user.id,
            provider=IdentityProvider.LOCAL.value,
            subject=email,
            password_hash=hash_password(password),
        )
    )
    await db.commit()
    logger.info("Created local user %s (role=%s)", email, role)
    return user


async def authenticate_local(db: AsyncSession, email: str, password: str) -> User:
    """Verify email+password; raises LocalAuthError on any failure.

    The error message is identical for "no such user" and "wrong password"
    to avoid account enumeration.
    """
    email = email.strip().lower()
    identity = await db.scalar(
        select(UserIdentity)
        .options(selectinload(UserIdentity.user))
        .where(
            UserIdentity.provider == IdentityProvider.LOCAL.value,
            UserIdentity.subject == email,
        )
    )
    generic_error = "Invalid email or password"
    if identity is None or not identity.password_hash:
        # Burn comparable time so timing doesn't leak which emails exist.
        _hasher.hash(password)
        raise LocalAuthError(generic_error)
    if not verify_password(identity.password_hash, password):
        raise LocalAuthError(generic_error)
    user = identity.user
    if user is None or not user.is_active:
        raise LocalAuthError("Account is disabled")
    if _hasher.check_needs_rehash(identity.password_hash):
        identity.password_hash = hash_password(password)
        await db.commit()
    return user


async def change_password(
    db: AsyncSession, user: User, current_password: str, new_password: str
) -> None:
    _validate_password(new_password)
    identity = await db.scalar(
        select(UserIdentity).where(
            UserIdentity.user_id == user.id,
            UserIdentity.provider == IdentityProvider.LOCAL.value,
        )
    )
    if identity is None or not identity.password_hash:
        raise LocalAuthError("This account has no local password")
    if not verify_password(identity.password_hash, current_password):
        raise LocalAuthError("Current password is incorrect")
    identity.password_hash = hash_password(new_password)
    await db.commit()
