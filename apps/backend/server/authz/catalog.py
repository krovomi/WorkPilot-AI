"""The permission catalog.

The catalog lives in **code, not in the database**. A permission the code does
not know about cannot gate anything, so storing the list in a table would only
create a second source of truth free to drift from the one that matters. What
*is* data is the assignment of permissions to roles (``roles.permissions``),
and that list is validated against this catalog on every write.

Naming is ``<domain>.<action>``, with ``<domain>.<subject>.<action>`` where a
domain has several distinct objects (``org.member.write`` vs ``org.role.write``).
Two actions are conventional and load-bearing, because
:mod:`server.authz.mounting` derives them from the HTTP method when a route
declares no explicit permission:

* ``read``  — GET/HEAD/OPTIONS
* ``write`` — POST/PUT/PATCH/DELETE

``privileged=True`` marks an action whose blast radius exceeds the data it
touches: it runs code, moves money, rewrites credentials, or hands out access.
Those are never granted by a default role below admin, the admin console shows
them apart, and :mod:`server.authz.stepup` can require a fresh authentication
before one is exercised.
"""

from __future__ import annotations

from dataclasses import dataclass
from types import MappingProxyType

READ = "read"
WRITE = "write"


@dataclass(frozen=True, slots=True)
class Permission:
    """One grantable capability."""

    key: str
    domain: str
    action: str
    label_key: str
    privileged: bool = False
    description_key: str = ""

    def __post_init__(self) -> None:
        expected = f"{self.domain}.{self.action}"
        if self.key != expected:
            raise ValueError(f"Permission key {self.key!r} does not match {expected!r}")


def _p(
    domain: str, action: str, *, privileged: bool = False
) -> Permission:
    key = f"{domain}.{action}"
    return Permission(
        key=key,
        domain=domain,
        action=action,
        label_key=f"administration:permissions.{key}.label",
        description_key=f"administration:permissions.{key}.description",
        privileged=privileged,
    )


# --------------------------------------------------------------------------
# Domains
# --------------------------------------------------------------------------
# Each domain is a product surface a role can be granted or denied wholesale.
# The ~72 sidebar views and 34 backend routers collapse onto these; the mapping
# is FEATURE_DOMAINS below.

DOMAINS: dict[str, str] = {
    "platform": "Cross-tenant operation of the deployment itself",
    "org": "One organization: its members, roles, settings and quotas",
    "project": "Projects and their membership",
    "task": "Specs and the Kanban board",
    "agent": "Running AI agents and terminals",
    "qa": "QA review, fixes and promotion",
    "review": "Human review and approval",
    "vcs": "GitHub / GitLab issues and pull requests",
    "integration": "Jira, Azure DevOps, Teams, webhooks",
    "insight": "Insights, ideation, roadmap, context, architecture",
    "analytics": "Dashboards, analytics, learning loop, cost",
    "ops": "Mission control, self-healing, scheduler, hooks",
    "security": "Guardrails, sandbox, injection guard, compliance",
    "audit": "The audit trail",
    "settings": "Provider credentials, models, MCP servers, agent tools",
    "marketplace": "MCP and plugin marketplaces",
    "lab": "Arena, playground, replay, parallel variations, pair programming",
}


# --------------------------------------------------------------------------
# The catalog
# --------------------------------------------------------------------------

_ALL: tuple[Permission, ...] = (
    # -- platform: the super-admin surface, above any single tenant ---------
    _p("platform", "read"),
    _p("platform", "org.write", privileged=True),
    _p("platform", "org.delete", privileged=True),
    _p("platform", "impersonate", privileged=True),
    # -- org ---------------------------------------------------------------
    _p("org", "read"),
    _p("org", "write"),
    _p("org", "member.read"),
    _p("org", "member.write", privileged=True),
    _p("org", "role.read"),
    _p("org", "role.write", privileged=True),
    _p("org", "invitation.read"),
    _p("org", "invitation.write", privileged=True),
    _p("org", "quota.read"),
    _p("org", "quota.write", privileged=True),
    _p("org", "session.read"),
    _p("org", "session.revoke", privileged=True),
    # -- project -----------------------------------------------------------
    _p("project", "read"),
    _p("project", "write"),
    _p("project", "create"),
    _p("project", "delete", privileged=True),
    _p("project", "member.read"),
    _p("project", "member.write", privileged=True),
    # -- task (specs + Kanban) ---------------------------------------------
    _p("task", "read"),
    _p("task", "write"),
    _p("task", "claim"),
    _p("task", "delete"),
    _p("task", "merge", privileged=True),
    # -- agent -------------------------------------------------------------
    _p("agent", "read"),
    _p("agent", "write"),
    _p("agent", "execute", privileged=True),
    _p("agent", "cancel"),
    _p("agent", "terminal", privileged=True),
    # -- qa ----------------------------------------------------------------
    _p("qa", "read"),
    _p("qa", "write"),
    _p("qa", "promote"),
    # -- review ------------------------------------------------------------
    _p("review", "read"),
    _p("review", "write"),
    _p("review", "comment"),
    _p("review", "approve"),
    # -- vcs ---------------------------------------------------------------
    _p("vcs", "read"),
    _p("vcs", "write"),
    _p("vcs", "pr.create"),
    _p("vcs", "pr.merge", privileged=True),
    # -- integration -------------------------------------------------------
    _p("integration", "read"),
    _p("integration", "write", privileged=True),
    # -- insight -----------------------------------------------------------
    _p("insight", "read"),
    _p("insight", "write"),
    # -- analytics ---------------------------------------------------------
    _p("analytics", "read"),
    _p("analytics", "write"),
    # -- ops ---------------------------------------------------------------
    _p("ops", "read"),
    _p("ops", "write"),
    _p("ops", "execute", privileged=True),
    # -- security ----------------------------------------------------------
    _p("security", "read"),
    _p("security", "write", privileged=True),
    # -- audit -------------------------------------------------------------
    _p("audit", "read"),
    # The trail is append-only; a "write" here is an append, never an edit.
    _p("audit", "write"),
    _p("audit", "export"),
    # -- settings ----------------------------------------------------------
    _p("settings", "read"),
    _p("settings", "write"),
    _p("settings", "provider.read", privileged=True),
    _p("settings", "provider.write", privileged=True),
    # -- marketplace -------------------------------------------------------
    _p("marketplace", "read"),
    _p("marketplace", "install", privileged=True),
    # -- lab ---------------------------------------------------------------
    _p("lab", "read"),
    _p("lab", "write"),
)

PERMISSIONS: MappingProxyType[str, Permission] = MappingProxyType(
    {p.key: p for p in _ALL}
)

ALL_PERMISSION_KEYS: frozenset[str] = frozenset(PERMISSIONS)

PRIVILEGED_PERMISSION_KEYS: frozenset[str] = frozenset(
    key for key, p in PERMISSIONS.items() if p.privileged
)


def is_valid(key: str) -> bool:
    return key in PERMISSIONS


def validate_keys(keys: object) -> list[str]:
    """Normalize and validate a role's permission list.

    Raises ``ValueError`` naming every unknown key — a role referencing a
    permission the code does not implement is silently powerless, which is a
    far worse failure than a rejected write.
    """
    if not isinstance(keys, (list, tuple, set, frozenset)):
        raise ValueError("permissions must be a list of permission keys")
    cleaned = []
    for k in keys:
        if not isinstance(k, str):
            raise ValueError("permissions must be a list of strings")
        cleaned.append(k.strip())
    unknown = sorted({k for k in cleaned if k not in PERMISSIONS})
    if unknown:
        raise ValueError(f"Unknown permission keys: {', '.join(unknown)}")
    return sorted(set(cleaned))


def expand_domain(domain: str) -> frozenset[str]:
    """Every permission in a domain. Handy for building roles."""
    return frozenset(k for k, p in PERMISSIONS.items() if p.domain == domain)


def catalog_payload() -> list[dict]:
    """Serializable catalog, for the admin console's permission matrix."""
    return [
        {
            "key": p.key,
            "domain": p.domain,
            "action": p.action,
            "labelKey": p.label_key,
            "descriptionKey": p.description_key,
            "privileged": p.privileged,
        }
        for p in sorted(_ALL, key=lambda x: (x.domain, x.action))
    ]


# --------------------------------------------------------------------------
# Feature → domain map
# --------------------------------------------------------------------------
# Keys are the ``feature`` argument passed to
# :func:`server.authz.mounting.mount_guarded` at each ``include_router`` site
# in ``provider_api``. Keeping the map here rather than beside each router is
# what lets a test assert that every mounted router is covered.

FEATURE_DOMAINS: MappingProxyType[str, str] = MappingProxyType(
    {
        "analytics": "analytics",
        "mission_control": "ops",
        "replay": "lab",
        "model_router": "settings",
        "longevity": "analytics",
        "architecture_drift": "insight",
        "generational_tests": "qa",
        "cognitive_context": "insight",
        "agent_health": "ops",
        "cicd_anomaly": "ops",
        "license_governance": "security",
        "domain_agents": "agent",
        "i18n_scaler": "insight",
        "audit_trail": "audit",
        "pair_realtime": "lab",
        "code_playground": "lab",
        "cost_estimator": "analytics",
        "restart_planner": "ops",
        "prompt_preview": "agent",
        "timeline": "analytics",
        "progress_indicator": "task",
        "qa_promotion": "qa",
        "workflow_profile": "task",
        "slash_commands": "agent",
        "parallel_variations": "lab",
        "virtual_reviewer": "review",
        "test_generation": "qa",
        "github": "vcs",
        "system_status": "ops",
        "dashboard": "analytics",
        "agent_endpoints": "agent",
        "event_hooks": "ops",
        "notifications": "integration",
        "providers": "settings",
    }
)


def domain_for_feature(feature: str) -> str:
    try:
        return FEATURE_DOMAINS[feature]
    except KeyError:  # pragma: no cover - guarded by test_authz_catalog
        raise KeyError(
            f"Unknown feature {feature!r}. Add it to catalog.FEATURE_DOMAINS so "
            "its routes are covered by an explicit permission domain."
        ) from None
