"""Invitation-only self-service signup.

An admin issues an :class:`~server.db.models.Invitation` bound to a specific
email. The invitee follows the link, sets a password, and a local account is
created. Security properties:

- The raw token (256-bit, urlsafe) is returned to the issuer once and never
  stored; only its SHA-256 hash is persisted and looked up.
- Single-use (``accepted_at``) and expiring (``expires_at``); acceptance is
  also guarded by the unique ``users.email`` constraint, so a token race
  cannot create two accounts.
- The target email is fixed by the issuer; the invitee cannot change it.
- The organization is fixed at creation: the one the issuer is acting in. The
  invitee joins that organization, with the role recorded on the invitation,
  and no other.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
from datetime import UTC, datetime, timedelta

from server.auth.local import create_local_user
from server.config import get_settings
from server.db.models import (
    AuditLog,
    GlobalRole,
    Invitation,
    Organization,
    OrgMember,
    Project,
    ProjectMember,
    ProjectRole,
    Role,
    RoleScope,
    User,
)
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


class InvitationError(Exception):
    """Invalid, expired, revoked or already-used invitation."""


def generate_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(UTC)


def _aware(dt: datetime) -> datetime:
    # SQLite returns naive datetimes; treat them as UTC.
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=UTC)


def build_invite_link(token: str) -> str:
    """Public acceptance link, or a bare ``?token=`` fragment if no base URL."""
    settings = get_settings()
    if settings.public_base_url:
        return f"{settings.public_base_url}/invite?token={token}"
    return f"/invite?token={token}"


async def _org_role(db: AsyncSession, org_id: str, slug: str) -> Role:
    """An organization-scope role usable in ``org_id``: built-in or its own."""
    role = await db.scalar(
        select(Role).where(
            Role.slug == slug,
            Role.scope == RoleScope.ORG.value,
            or_(Role.org_id.is_(None), Role.org_id == org_id),
        )
    )
    if role is None:
        raise InvitationError(f"Invalid organization role: {slug}")
    return role


async def create_invitation(
    db: AsyncSession,
    *,
    email: str,
    org_id: str,
    role: str = GlobalRole.MEMBER.value,
    invited_by: str | None,
    org_role: str | None = None,
    project_id: str | None = None,
    project_role: str | None = None,
) -> tuple[Invitation, str]:
    """Create a pending invitation into ``org_id``. Returns (invitation, raw_token).

    ``org_id`` is the organization the issuer is acting in, as the request
    resolved it; the caller has already checked the issuer's right to invite
    there. ``org_role`` defaults to the organization role the platform
    ``role`` maps onto, as for the users of a single-tenant deployment. A
    project, when given, must belong to the same organization.
    """
    from server.authz.roles import DEFAULT_ORG_ROLE, LEGACY_ROLE_MAP

    email = email.strip().lower()
    if not email or "@" not in email:
        raise InvitationError("Invalid email address")
    if role not in {r.value for r in GlobalRole}:
        raise InvitationError(f"Invalid role: {role}")
    if not org_id or await db.get(Organization, org_id) is None:
        raise InvitationError("Unknown organization")
    membership_role = await _org_role(
        db, org_id, org_role or LEGACY_ROLE_MAP.get(role, DEFAULT_ORG_ROLE)
    )
    if project_id is not None:
        project_org = await db.scalar(
            select(Project.org_id).where(Project.id == project_id)
        )
        if project_org != org_id:
            raise InvitationError("Unknown project")
        project_role = project_role or ProjectRole.MEMBER.value
        if project_role not in {r.value for r in ProjectRole}:
            raise InvitationError(f"Invalid project role: {project_role}")

    # Reject if an active account already exists for this email.
    existing = await db.scalar(select(User).where(User.email == email))
    if existing is not None:
        raise InvitationError("A user with this email already exists")

    settings = get_settings()
    token = generate_token()
    invitation = Invitation(
        email=email,
        role=role,
        token_hash=hash_token(token),
        invited_by=invited_by,
        org_id=org_id,
        org_role_id=membership_role.id,
        project_id=project_id,
        project_role=project_role,
        expires_at=_utcnow() + timedelta(hours=settings.invitation_ttl_hours),
    )
    db.add(invitation)
    db.add(
        AuditLog(
            user_id=invited_by,
            org_id=org_id,
            project_id=project_id,
            action="auth.invitation.created",
            payload={"email": email, "role": role, "org_role": membership_role.slug},
        )
    )
    await db.commit()
    return invitation, token


async def _fetch_by_token(db: AsyncSession, token: str) -> Invitation | None:
    if not token:
        return None
    return await db.scalar(
        select(Invitation).where(Invitation.token_hash == hash_token(token))
    )


def _assert_usable(invitation: Invitation | None) -> Invitation:
    if invitation is None:
        raise InvitationError("Invitation not found")
    if invitation.revoked_at is not None:
        raise InvitationError("Invitation was revoked")
    if invitation.accepted_at is not None:
        raise InvitationError("Invitation has already been used")
    if _aware(invitation.expires_at) < _utcnow():
        raise InvitationError("Invitation has expired")
    return invitation


async def lookup_invitation(db: AsyncSession, token: str) -> Invitation:
    """Return a still-usable invitation for the given token, else raise."""
    return _assert_usable(await _fetch_by_token(db, token))


async def accept_invitation(
    db: AsyncSession,
    token: str,
    display_name: str,
    password: str,
) -> User:
    """Create the account behind an invitation and consume it (single-use).

    The email is taken from the invitation, never from the request, so an
    invitee cannot register a different address than the one invited. The
    account joins the invitation's organization, with the invitation's role;
    an invitation that names no organization, or whose role no longer exists,
    is refused before any account is created.
    """
    invitation = _assert_usable(await _fetch_by_token(db, token))
    if invitation.org_id is None or invitation.org_role_id is None:
        raise InvitationError("Invitation is no longer valid; ask for a new one")

    # create_local_user enforces the password policy and the unique-email
    # constraint (which also makes a token race safe: the 2nd accept fails).
    user = await create_local_user(
        db,
        email=invitation.email,
        password=password,
        display_name=display_name,
        role=invitation.role,
    )

    invitation.accepted_at = _utcnow()
    db.add(
        OrgMember(
            org_id=invitation.org_id,
            user_id=user.id,
            role_id=invitation.org_role_id,
        )
    )
    if invitation.project_id is not None:
        db.add(
            ProjectMember(
                project_id=invitation.project_id,
                user_id=user.id,
                role=invitation.project_role or ProjectRole.MEMBER.value,
            )
        )
    db.add(
        AuditLog(
            user_id=user.id,
            org_id=invitation.org_id,
            project_id=invitation.project_id,
            action="auth.invitation.accepted",
            payload={"email": invitation.email},
        )
    )
    await db.commit()
    logger.info("Invitation accepted for %s", invitation.email)
    return user


async def list_pending(db: AsyncSession, org_id: str) -> list[Invitation]:
    """Invitations into ``org_id`` that are neither accepted nor revoked (may be expired)."""
    rows = await db.scalars(
        select(Invitation)
        .where(
            Invitation.org_id == org_id,
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
        )
        .order_by(Invitation.created_at.desc())
    )
    return list(rows)


async def revoke(db: AsyncSession, invitation_id: str, org_id: str) -> bool:
    invitation = await db.get(Invitation, invitation_id)
    if (
        invitation is None
        or invitation.org_id != org_id
        or invitation.accepted_at is not None
    ):
        return False
    if invitation.revoked_at is None:
        invitation.revoked_at = _utcnow()
        await db.commit()
    return True
