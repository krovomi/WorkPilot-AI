"""Deciding which organization a request acts in.

Precedence, highest first:

1. the ``X-WorkPilot-Org`` header, **always verified against membership** —
   it is a convenience for a client holding one token and switching tenants in
   the UI, never an assertion the server trusts;
2. the ``org`` claim of the access token, verified the same way, because a
   membership can be revoked while a 15-minute token is still valid;
3. the caller's only organization, when they have exactly one.

Several memberships and no explicit choice is left unresolved rather than
guessed: acting in the wrong tenant is worse than a 400 telling the client to
pick.
"""

from __future__ import annotations

import logging

from server.authz.engine import default_org_id
from server.db.models import GlobalRole, Organization, OrgMember
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

ORG_HEADER = "X-WorkPilot-Org"


async def _is_member(db: AsyncSession, user_id: str, org_id: str) -> bool:
    found = await db.scalar(
        select(OrgMember.id).where(
            OrgMember.org_id == org_id, OrgMember.user_id == user_id
        )
    )
    return found is not None


async def can_act_in(
    db: AsyncSession, user_id: str, platform_role: str, org_id: str
) -> bool:
    """Whether this user may act inside `org_id`.

    A platform admin may, by definition — operating the deployment means
    reaching into any tenant, and that is exactly why the role is separate from
    every organization role and never granted by one.
    """
    if platform_role == GlobalRole.ADMIN.value:
        return (
            await db.scalar(select(Organization.id).where(Organization.id == org_id))
            is not None
        )
    return await _is_member(db, user_id, org_id)


async def resolve_org_id(
    db: AsyncSession,
    *,
    user_id: str,
    platform_role: str,
    header_value: str | None,
    claim_value: str | None,
) -> str | None:
    """The organization this request acts in, or ``None`` if undecidable."""
    for candidate, source in ((header_value, "header"), (claim_value, "claim")):
        if not candidate:
            continue
        candidate = candidate.strip()
        if not candidate:
            continue
        if await can_act_in(db, user_id, platform_role, candidate):
            return candidate
        # Not an error: a token issued before the user left an organization is
        # still a valid token. Fall through and let them act where they can.
        logger.info(
            "Ignoring %s organization %s for user %s: not a member",
            source,
            candidate,
            user_id,
        )

    return await default_org_id(db, user_id, platform_role)
