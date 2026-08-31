"""FastAPI dependencies for permission checks."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import Depends, HTTPException, Request
from server.authz.catalog import PERMISSIONS
from server.authz.principal import Principal, get_principal


def _assert_known(*permissions: str) -> None:
    """A guard naming a permission the catalog does not define never fires.

    Checked at import time (the dependency factories run when the module
    defining the route is imported), so a typo is a startup failure rather than
    a route that quietly accepts everyone.
    """
    unknown = sorted(p for p in permissions if p not in PERMISSIONS)
    if unknown:
        raise ValueError(
            f"Unknown permission(s) in a route guard: {', '.join(unknown)}. "
            "Add them to server.authz.catalog or fix the spelling."
        )


def require_permission(*permissions: str) -> Callable[..., Principal]:
    """Require **every** listed permission.

    Usage::

        @router.post("/merge", dependencies=[Depends(require_permission("task.merge"))])
    """
    _assert_known(*permissions)

    def _check(principal: Principal = Depends(get_principal)) -> Principal:
        missing = [p for p in permissions if not principal.has(p)]
        if missing:
            raise HTTPException(
                status_code=403,
                detail=f"Missing permission: {', '.join(sorted(missing))}",
            )
        return principal

    return _check


def require_any_permission(*permissions: str) -> Callable[..., Principal]:
    """Require at least one of the listed permissions."""
    _assert_known(*permissions)

    def _check(principal: Principal = Depends(get_principal)) -> Principal:
        if not principal.has_any(*permissions):
            raise HTTPException(
                status_code=403,
                detail=f"Requires one of: {', '.join(sorted(permissions))}",
            )
        return principal

    return _check


def require_platform_admin(
    principal: Principal = Depends(get_principal),
) -> Principal:
    """Cross-tenant operations. Never granted by an organization role."""
    if not (principal.is_local or principal.is_platform_admin):
        raise HTTPException(status_code=403, detail="Platform administrator required")
    return principal


def require_org(request: Request) -> str:
    """The active organization id, or 400 when the caller has not picked one."""
    org_id = getattr(request.state, "org_id", None)
    if not org_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "No active organization for this request. Send the "
                "X-WorkPilot-Org header or sign in again to pick one."
            ),
        )
    return org_id
