"""Authorization: the permission catalog, roles, principals and route guards.

Layered so that importing the catalog never drags in the database:

* :mod:`~server.authz.catalog` — the permission catalog (code, not data)
* :mod:`~server.authz.roles` — built-in role definitions seeded into the DB
* :mod:`~server.authz.principal` — who is calling, and the local-mode principal
* :mod:`~server.authz.deps` — ``require_permission`` and friends
* :mod:`~server.authz.mounting` — attaching a permission to a whole router
* :mod:`~server.authz.engine` — resolving effective permissions from the DB
* :mod:`~server.authz.scope` — mapping a project to a filesystem path safely
"""

from __future__ import annotations

from server.authz.catalog import (
    ALL_PERMISSION_KEYS,
    PERMISSIONS,
    PRIVILEGED_PERMISSION_KEYS,
    Permission,
    catalog_payload,
    domain_for_feature,
    is_valid,
    validate_keys,
)
from server.authz.deps import (
    require_any_permission,
    require_org,
    require_permission,
    require_platform_admin,
)
from server.authz.mounting import ROUTE_OVERRIDES, mount_guarded, permission_for
from server.authz.principal import LOCAL_PRINCIPAL, Principal, get_principal
from server.authz.roles import (
    DEFAULT_ORG_ROLE,
    LEGACY_ROLE_MAP,
    SYSTEM_ROLE_SLUGS,
    SYSTEM_ROLES,
    RoleDef,
)

__all__ = [
    "ALL_PERMISSION_KEYS",
    "DEFAULT_ORG_ROLE",
    "LEGACY_ROLE_MAP",
    "LOCAL_PRINCIPAL",
    "PERMISSIONS",
    "PRIVILEGED_PERMISSION_KEYS",
    "ROUTE_OVERRIDES",
    "SYSTEM_ROLES",
    "SYSTEM_ROLE_SLUGS",
    "Permission",
    "Principal",
    "RoleDef",
    "catalog_payload",
    "domain_for_feature",
    "get_principal",
    "is_valid",
    "mount_guarded",
    "permission_for",
    "require_any_permission",
    "require_org",
    "require_permission",
    "require_platform_admin",
    "validate_keys",
]
