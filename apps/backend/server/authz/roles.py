"""Built-in role definitions.

These are seeded into the ``roles`` table with ``org_id IS NULL`` and
``is_system = True``, which makes them visible to every organization and
read-only in the admin console. An organization that needs something else
creates a custom role; it never edits these, so an upgrade that adds a
permission to a built-in role reaches every tenant.

The definitions live in code for the same reason the catalog does: the seed
has to be reproducible from the source tree, and a fresh database has to end
up with exactly what an upgraded one has.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from server.authz.catalog import (
    ALL_PERMISSION_KEYS,
    PRIVILEGED_PERMISSION_KEYS,
    expand_domain,
)

ORG_SCOPE = "org"
PROJECT_SCOPE = "project"


@dataclass(frozen=True, slots=True)
class RoleDef:
    slug: str
    name: str
    description: str
    scope: str
    permissions: frozenset[str] = field(default_factory=frozenset)


def _readonly_everything() -> frozenset[str]:
    """Every non-privileged ``.read`` permission, and nothing that changes state.

    Derived rather than listed: a new domain added to the catalog should make
    ``viewer`` able to see it, not silently omit it.

    Privileged reads are excluded, and that exclusion is the point of marking a
    *read* privileged at all. ``settings.provider.read`` returns the
    deployment's LLM credentials in clear text — it is the reason
    ``deny_in_server_mode`` exists in ``provider_api`` — so "can look at
    everything" must not quietly mean "can read the API keys".
    """
    return frozenset(
        k
        for k in ALL_PERMISSION_KEYS
        if k.endswith(".read")
        and not k.startswith("platform.")
        and k not in PRIVILEGED_PERMISSION_KEYS
    )


_VIEWER = _readonly_everything()

_ANALYST = _VIEWER | {"analytics.write", "insight.write", "audit.export"}

_REVIEWER = _VIEWER | {
    "review.write",
    "review.comment",
    "review.approve",
    "qa.write",
    "qa.promote",
}

_CONTRIBUTOR = _VIEWER | {
    "task.write",
    "task.claim",
    "task.delete",
    "qa.write",
    "review.comment",
    "insight.write",
    "lab.write",
    "vcs.write",
    "vcs.pr.create",
    "agent.write",
    "agent.execute",
    "agent.cancel",
}

_OPERATOR = _VIEWER | {
    "ops.write",
    "ops.execute",
    "agent.write",
    "agent.execute",
    "agent.cancel",
    "analytics.write",
    "audit.export",
}

_MAINTAINER = _CONTRIBUTOR | {
    "task.merge",
    "vcs.pr.merge",
    "qa.promote",
    "review.write",
    "review.approve",
    "project.write",
    "project.member.read",
    "ops.write",
    "settings.write",
}

# Org admin: everything inside the tenant, nothing across tenants.
_ADMIN = frozenset(k for k in ALL_PERMISSION_KEYS if not k.startswith("platform."))

# Owner is admin today; it exists as a separate role so an org can distinguish
# "can administer" from "owns the account" without a schema change later.
_OWNER = _ADMIN


SYSTEM_ROLES: tuple[RoleDef, ...] = (
    RoleDef(
        slug="owner",
        name="Owner",
        description="Full control of the organization, including billing and deletion.",
        scope=ORG_SCOPE,
        permissions=_OWNER,
    ),
    RoleDef(
        slug="admin",
        name="Administrator",
        description="Manages members, roles, quotas and settings of the organization.",
        scope=ORG_SCOPE,
        permissions=_ADMIN,
    ),
    RoleDef(
        slug="maintainer",
        name="Maintainer",
        description="Contributor rights plus merging, approving and project settings.",
        scope=ORG_SCOPE,
        permissions=_MAINTAINER,
    ),
    RoleDef(
        slug="contributor",
        name="Contributor",
        description="Creates specs and runs agents; cannot merge or change settings.",
        scope=ORG_SCOPE,
        permissions=_CONTRIBUTOR,
    ),
    RoleDef(
        slug="reviewer",
        name="Reviewer",
        description="Reviews and approves work; does not run agents.",
        scope=ORG_SCOPE,
        permissions=_REVIEWER,
    ),
    RoleDef(
        slug="operator",
        name="Operator",
        description="Runs and supervises agents, incidents and schedules.",
        scope=ORG_SCOPE,
        permissions=_OPERATOR,
    ),
    RoleDef(
        slug="analyst",
        name="Analyst",
        description="Reads everything and works with analytics and insights.",
        scope=ORG_SCOPE,
        permissions=_ANALYST,
    ),
    RoleDef(
        slug="viewer",
        name="Viewer",
        description="Read-only access.",
        scope=ORG_SCOPE,
        permissions=_VIEWER,
    ),
)

SYSTEM_ROLE_SLUGS: frozenset[str] = frozenset(r.slug for r in SYSTEM_ROLES)

# The role a brand-new member gets when none is named.
DEFAULT_ORG_ROLE = "contributor"

# The role given to the org created by the migration for an existing
# single-tenant deployment's users, so nobody loses access on upgrade.
LEGACY_ROLE_MAP: dict[str, str] = {
    "admin": "admin",
    "member": "contributor",
    "viewer": "viewer",
}


def system_role(slug: str) -> RoleDef:
    for role in SYSTEM_ROLES:
        if role.slug == slug:
            return role
    raise KeyError(f"Unknown system role {slug!r}")


def privileged_in(permissions: frozenset[str]) -> frozenset[str]:
    """Which of these permissions are privileged. Used by the console and step-up."""
    return permissions & PRIVILEGED_PERMISSION_KEYS


__all__ = [
    "DEFAULT_ORG_ROLE",
    "LEGACY_ROLE_MAP",
    "ORG_SCOPE",
    "PROJECT_SCOPE",
    "SYSTEM_ROLES",
    "SYSTEM_ROLE_SLUGS",
    "RoleDef",
    "expand_domain",
    "privileged_in",
    "system_role",
]
