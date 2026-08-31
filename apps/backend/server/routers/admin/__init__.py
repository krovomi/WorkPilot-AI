"""The administration API.

Split by subject rather than served from one module, because the permissions
differ sharply: ``orgs`` carries the only platform-admin surface on the
deployment, while ``roles``, ``users`` and ``overview`` are org-scoped and
reachable by a tenant's own administrators.

Every router here mounts under ``/admin`` and every mutation writes an
``audit_log`` row through :mod:`server.services.audit`.
"""

from __future__ import annotations

from fastapi import APIRouter
from server.routers.admin.orgs import router as orgs_router
from server.routers.admin.overview import router as overview_router
from server.routers.admin.roles import router as roles_router
from server.routers.admin.users import router as users_router

router = APIRouter()
for _sub in (orgs_router, roles_router, users_router, overview_router):
    router.include_router(_sub)

__all__ = ["router"]
