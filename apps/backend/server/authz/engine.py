"""Resolving a user's effective permissions.

    effective(user, org, project) =
        every permission                       if the user is a platform admin
        otherwise  perms(org role)
                 ∪ perms(project role)         when a project is in scope
                 − org.settings.disabled_permissions

**Permissions are deliberately not carried in the access token.** A token lives
15 minutes; a permission removed from a role has to bite on the next request,
not a quarter of an hour later. So the set is resolved from the database once
per request and cached on ``request.state`` — which costs one indexed join, and
buys revocation that actually revokes.
"""

from __future__ import annotations

import logging

from server.authz.catalog import ALL_PERMISSION_KEYS
from server.db.models import (
    GlobalRole,
    Organization,
    OrgMember,
    ProjectMember,
    Role,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

_EVERYTHING = frozenset(ALL_PERMISSION_KEYS)


def _disabled_for(org: Organization | None) -> frozenset[str]:
    """Permissions switched off deployment-side for this tenant.

    A licence tier or a feature flag, expressed in the same vocabulary as
    roles so there is one thing to reason about. Unknown keys are ignored
    rather than rejected: an org configured against a newer build should not
    break when rolled back.
    """
    if org is None or not org.settings:
        return frozenset()
    raw = org.settings.get("disabled_permissions")
    if not isinstance(raw, (list, tuple, set, frozenset)):
        return frozenset()
    return frozenset(str(k) for k in raw)


async def org_role_for(db: AsyncSession, user_id: str, org_id: str) -> Role | None:
    """The user's role in this organization, or ``None`` if not a member."""
    return await db.scalar(
        select(Role)
        .join(OrgMember, OrgMember.role_id == Role.id)
        .where(OrgMember.org_id == org_id, OrgMember.user_id == user_id)
    )


async def project_role_for(
    db: AsyncSession, user_id: str, project_id: str
) -> Role | None:
    """A project-scoped role granting permissions on top of the org role."""
    return await db.scalar(
        select(Role)
        .join(ProjectMember, ProjectMember.role_id == Role.id)
        .where(
            ProjectMember.project_id == project_id,
            ProjectMember.user_id == user_id,
        )
    )


async def resolve_permissions(
    db: AsyncSession,
    *,
    user_id: str,
    platform_role: str,
    org_id: str | None,
    project_id: str | None = None,
) -> tuple[frozenset[str], str | None]:
    """Return ``(permissions, org_role_slug)`` for this principal.

    A platform admin gets everything, including cross-tenant ``platform.*``.
    Everyone else gets exactly what their roles grant inside one organization,
    which is what keeps tenants apart.
    """
    if platform_role == GlobalRole.ADMIN.value:
        return _EVERYTHING, "platform-admin"

    if not org_id:
        # Authenticated, but not acting within any organization: no data of any
        # tenant is reachable. The caller can still read /auth/me and pick one.
        return frozenset(), None

    org_role = await org_role_for(db, user_id, org_id)
    if org_role is None:
        return frozenset(), None

    granted = set(org_role.permissions or ())

    if project_id:
        project_role = await project_role_for(db, user_id, project_id)
        if project_role is not None:
            granted |= set(project_role.permissions or ())

    org = await db.get(Organization, org_id)
    if org is not None and not org.is_active:
        # A suspended tenant is readable by its admins and nothing more, so an
        # operator can still see why it was suspended.
        granted &= {k for k in granted if k.endswith(".read")}

    granted -= _disabled_for(org)

    # Drop anything the running build does not implement: a role written by a
    # newer version must not smuggle in a key this one cannot reason about.
    unknown = granted - ALL_PERMISSION_KEYS
    if unknown:
        logger.debug("Ignoring unknown permission keys on a role: %s", sorted(unknown))
        granted &= ALL_PERMISSION_KEYS

    return frozenset(granted), org_role.slug


async def user_organizations(db: AsyncSession, user_id: str) -> list[Organization]:
    """Organizations the user belongs to, oldest first."""
    return list(
        await db.scalars(
            select(Organization)
            .join(OrgMember, OrgMember.org_id == Organization.id)
            .where(OrgMember.user_id == user_id)
            .order_by(Organization.created_at)
        )
    )


async def default_org_id(
    db: AsyncSession, user_id: str, platform_role: str
) -> str | None:
    """The organization to act in when the caller named none.

    A single membership is unambiguous, so use it. Several is genuinely
    ambiguous, and guessing would silently act in the wrong tenant — the caller
    is asked to choose instead.
    """
    orgs = await user_organizations(db, user_id)
    if len(orgs) == 1:
        return orgs[0].id
    if orgs:
        return None
    if platform_role == GlobalRole.ADMIN.value:
        # A platform admin who belongs to nothing still administers the
        # deployment; they pick a tenant explicitly per request.
        return None
    return None
