"""Guarded mounting of the legacy feature routers.

``provider_api`` mounts ~34 routers that were written for a single-user desktop
app and carry no authorization of their own. Rather than edit ~150 endpoint
signatures, the permission is attached where the router is mounted:
``include_router(dependencies=[...])`` applies the dependency to every path
operation in the router. That matters here because seven of those routers
declare absolute paths (``@router.get("/api/dashboard/stats")``) with no
``prefix=``, so any policy table keyed on ``router.prefix`` would miss them —
whereas ``dependencies=`` does not care how the path was spelled.

The required permission is derived from the HTTP method:

* ``GET`` / ``HEAD`` / ``OPTIONS`` → ``<domain>.read``
* everything else                 → ``<domain>.write``

Method-derivation is a floor, not a ceiling. A route whose blast radius exceeds
its verb — ``POST /api/slash-commands/run`` executes an LLM agent with file and
network tools — is listed in :data:`ROUTE_OVERRIDES` and checked against the
route *template*, which FastAPI exposes as ``request.scope["route"].path`` by
the time dependencies run.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from server.authz.catalog import PERMISSIONS, domain_for_feature
from server.authz.principal import Principal, get_principal

logger = logging.getLogger(__name__)

_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})

# (method, route template) → permission required instead of the derived one.
# The template is the path as declared, including the prefix the router was
# mounted with and FastAPI's ``{param}`` placeholders.
ROUTE_OVERRIDES: dict[tuple[str, str], str] = {
    # Runs a full agent session with read/write/web tools rooted at a project.
    ("POST", "/api/slash-commands/run"): "agent.execute",
    # Executes arbitrary submitted code in the playground sandbox.
    ("POST", "/api/code-playground/run"): "agent.execute",
    # Starts and stops orchestration sessions.
    ("POST", "/api/mission-control/session/start"): "ops.execute",
    ("POST", "/api/mission-control/session/stop"): "ops.execute",
    # Scaffolds worktrees and runs variations.
    ("POST", "/api/parallel-variations/create"): "agent.execute",
    # Runs the reviewer agent.
    ("POST", "/api/virtual-reviewer/run"): "agent.execute",
    # Generates and writes test files.
    ("POST", "/api/test-generation/generate"): "agent.execute",
    # Fires a real outbound notification.
    ("POST", "/api/notifications/test"): "integration.write",
    # Audit trail is append-only and its exports carry personal data.
    ("GET", "/api/audit-trail/export/soc2"): "audit.export",
    ("GET", "/api/audit-trail/export/gdpr"): "audit.export",
}


def permission_for(method: str, route_path: str, domain: str) -> str:
    """The permission a request to this route requires."""
    override = ROUTE_OVERRIDES.get((method.upper(), route_path))
    if override:
        return override
    action = "read" if method.upper() in _READ_METHODS else "write"
    return f"{domain}.{action}"


def _feature_guard(feature: str):
    """Build the dependency enforcing `feature`'s domain permission."""
    domain = domain_for_feature(feature)

    # Fail at import rather than at request time if the domain is missing the
    # read/write pair the derivation needs.
    for action in ("read", "write"):
        key = f"{domain}.{action}"
        if key not in PERMISSIONS:
            raise ValueError(
                f"Feature {feature!r} maps to domain {domain!r}, which has no "
                f"{key!r} permission. Add it to server.authz.catalog."
            )

    def _check(
        request: Request, principal: Principal = Depends(get_principal)
    ) -> Principal:
        route = request.scope.get("route")
        route_path = getattr(route, "path", request.url.path)
        needed = permission_for(request.method, route_path, domain)
        if not principal.has(needed):
            raise HTTPException(status_code=403, detail=f"Missing permission: {needed}")
        return principal

    return _check


def mount_guarded(
    app: FastAPI,
    router: APIRouter,
    feature: str,
    *,
    enabled: bool = True,
    **include_kwargs,
) -> None:
    """``app.include_router`` with the feature's permission attached.

    ``enabled=False`` (local mode) mounts the router untouched, so the desktop
    app pays nothing for a check that would always pass.
    """
    if not enabled:
        app.include_router(router, **include_kwargs)
        return

    guard = _feature_guard(feature)
    dependencies = list(include_kwargs.pop("dependencies", []) or [])
    dependencies.append(Depends(guard))
    app.include_router(router, dependencies=dependencies, **include_kwargs)
    logger.debug(
        "Mounted %s router guarded by %s.*", feature, domain_for_feature(feature)
    )
