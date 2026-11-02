"""Wires multi-user server mode into the existing FastAPI app.

Called unconditionally from ``provider_api``; does nothing unless
``WORKPILOT_SERVER_MODE`` is enabled, so local mode keeps its exact
historical behavior (no auth, no DB).
"""

from __future__ import annotations

import asyncio
import json
import logging
from importlib import import_module

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from server.config import get_settings

logger = logging.getLogger(__name__)

# Paths reachable without a bearer token in server mode.
PUBLIC_PATHS = {
    "/auth/login",
    "/auth/refresh",
    "/auth/logout",
    "/auth/oidc/exchange",
    "/auth/config",
    "/auth/invitations/lookup",
    "/auth/invitations/accept",
    "/health",
    "/docs",
    "/openapi.json",
}

_db_ready = False
_db_init_lock: asyncio.Lock | None = None

# Query/body keys through which a client used to hand the backend an absolute
# filesystem path to read and write. In a single-user desktop app that was
# harmless — the backend ran as the person who chose the directory. On a shared
# server it is a cross-tenant read/write, so in server mode they are refused
# outright and the caller uses ``project_id`` instead. See
# ``server.authz.scope``.
CLIENT_PATH_PARAMS = frozenset(
    {
        # The project checkout, in every spelling the API and the Electron
        # client use.
        "project_dir",
        "projectDir",
        "project_path",
        "projectPath",
        "spec_dir",
        "specDir",
        "repo_path",
        "repoPath",
        "cwd",
        "working_dir",
        "workingDir",
        # Where the audit trail is read from and written to. A caller that can
        # choose this can point the tamper-evident log at another tenant's
        # directory — or read theirs.
        "storage_dir",
        "storageDir",
        # Individual files named by the test-generation endpoints. A file path
        # is no safer than a directory path: it is still the client choosing
        # what the server reads and writes.
        "file_path",
        "filePath",
        "existing_test_path",
        "existingTestPath",
        "output_path",
        "outputPath",
        "target_path",
        "targetPath",
        # The i18n scaler reads and rewrites the locale files under this
        # directory (`/api/i18n-scaler/mutate`).
        "locales_dir",
        "localesDir",
    }
)

#: The body media types a route can read fields from. FastAPI parses a body as
#: JSON when it declares no content type or a JSON one, and as a form for the
#: other two; anything else reaches no declared body parameter.
_FORM_TYPES = frozenset({"application/x-www-form-urlencoded", "multipart/form-data"})


async def _attach_principal(request: Request, claims: dict) -> None:
    """Resolve tenant + permissions and put a Principal on ``request.state``."""
    from server.authz.engine import resolve_permissions
    from server.authz.principal import Principal
    from server.authz.tenancy import ORG_HEADER, resolve_org_id
    from server.db.engine import get_session_factory

    user_id = claims["sub"]
    platform_role = claims.get("role", "member")

    async with get_session_factory()() as db:
        org_id = await resolve_org_id(
            db,
            user_id=user_id,
            platform_role=platform_role,
            header_value=request.headers.get(ORG_HEADER),
            claim_value=claims.get("org"),
        )
        permissions, org_role_slug = await resolve_permissions(
            db,
            user_id=user_id,
            platform_role=platform_role,
            org_id=org_id,
        )

    request.state.org_id = org_id
    request.state.principal = Principal(
        id=user_id,
        email=claims.get("email", ""),
        display_name=claims.get("name", ""),
        platform_role=platform_role,
        org_id=org_id,
        org_role_slug=org_role_slug,
        permissions=permissions,
    )


def _path_keys_in(payload: object) -> set[str]:
    """Every key of `CLIENT_PATH_PARAMS` anywhere in a decoded JSON body.

    Nested as well as top level: FastAPI embeds a model under its parameter
    name when a route takes more than one body parameter, and a route that
    takes a bare ``dict`` (`/api/slash-commands/run`) reads whatever keys it
    likes. Walked with a stack, not recursion — the depth is the client's.
    """
    found: set[str] = set()
    stack = [payload]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            found.update(k for k in node if k in CLIENT_PATH_PARAMS)
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return found


async def _body_path_keys(request: Request) -> set[str]:
    """The `CLIENT_PATH_PARAMS` keys a request carries in its body.

    Reading the body here does not consume it: Starlette caches what a
    middleware reads and replays it to the route. Any body that is not a form
    is tried as JSON, whatever content type it declares — wider than FastAPI's
    own rule, so nothing FastAPI reads as JSON goes unread here. A body that
    does not parse is not judged: the route refuses it on its own, with a 422.
    """
    media_type = (
        request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    )
    body = await request.body()
    if not body:
        return set()

    if media_type in _FORM_TYPES:
        try:
            form = await request.form()
        except Exception:  # noqa: BLE001 - malformed form: the route's 422
            return set()
        try:
            return set(CLIENT_PATH_PARAMS.intersection(form.keys()))
        finally:
            await form.close()

    try:
        payload = json.loads(body)
    except (ValueError, RecursionError):
        return set()
    return _path_keys_in(payload)


async def _reject_client_supplied_paths(request: Request) -> JSONResponse | None:
    """Refuse a request that hands the server a filesystem path to work on.

    Enforced centrally rather than endpoint by endpoint, because the failure
    mode being prevented is precisely that someone adds an endpoint and forgets.
    The query string and the body are both read: about forty routes take
    `project_dir`, `spec_dir` or `file_path` in a JSON body, where a check on
    the query string alone never looked.
    """
    offending = sorted(
        CLIENT_PATH_PARAMS.intersection(request.query_params.keys())
        | await _body_path_keys(request)
    )
    if not offending:
        return None
    return JSONResponse(
        status_code=400,
        content={
            "detail": (
                f"{', '.join(offending)} cannot be supplied by the client in "
                "server mode. Identify the project with 'project_id' instead; "
                "the server resolves its own checkout."
            )
        },
    )


async def _ensure_db_ready() -> None:
    """Lazy one-time schema init, executed inside uvicorn's event loop.

    Production runs ``alembic upgrade head`` before boot; this makes
    ``create_all`` a cheap no-op while keeping dev/test setups zero-step.
    """
    global _db_ready, _db_init_lock
    if _db_ready:
        return
    if _db_init_lock is None:
        _db_init_lock = asyncio.Lock()
    async with _db_init_lock:
        if _db_ready:
            return
        from server.db.engine import init_db

        await init_db()
        _db_ready = True
        logger.info("Server-mode database initialized")


def mount_server_mode(app: FastAPI) -> bool:
    """Activate auth middleware + multi-user routers. Returns True if active."""
    settings = get_settings()
    if not settings.server_mode:
        return False

    from server.auth.jwt_tokens import TokenError, decode_access_token

    # SECURITY: the auth middleware is registered BEFORE any router is mounted.
    # Starlette applies middleware to the whole app regardless of registration
    # order, but doing it first means that if a router import blows up below,
    # we can never end up with protected routes mounted and no gate in front of
    # them. Callers additionally treat any exception from this function as fatal.
    @app.middleware("http")
    async def _auth_middleware(request: Request, call_next):
        await _ensure_db_ready()

        if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
            return await call_next(request)

        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return JSONResponse(
                status_code=401, content={"detail": "Authentication required"}
            )
        try:
            claims = decode_access_token(auth[len("Bearer ") :].strip())
        except TokenError as e:
            # One answer for every way a token can be bad. `TokenError` says
            # which — expired, malformed, wrong signature — and that is a
            # distinction worth denying an unauthenticated caller, who can
            # otherwise probe it. The reason goes to the log instead.
            logger.warning("Server mode: rejected bearer token: %s", e)
            return JSONResponse(
                status_code=401, content={"detail": "Invalid or expired token"}
            )

        # Make the principal available to legacy endpoints that want
        # attribution without depending on server.auth.deps.
        request.state.user_id = claims["sub"]
        request.state.user_email = claims.get("email", "")
        request.state.user_role = claims.get("role", "member")

        # Resolve the tenant and the effective permissions once per request.
        # Doing it here rather than in a dependency means every route — the ~150
        # legacy ones included — has an authorized principal available, and pays
        # for it exactly once.
        try:
            await _attach_principal(request, claims)
        except Exception:
            logger.exception("Failed to resolve the principal for a request")
            return JSONResponse(
                status_code=500, content={"detail": "Authorization unavailable"}
            )

        forbidden = await _reject_client_supplied_paths(request)
        if forbidden is not None:
            return forbidden

        return await call_next(request)

    from server.routers.auth import router as auth_router

    app.include_router(auth_router)

    for module_path, label in (
        ("server.routers.invitations", "invitations"),
        ("server.routers.projects", "projects"),
        ("server.routers.specs", "specs"),
        ("server.routers.users", "users"),
        ("server.routers.devices", "devices"),
        ("server.routers.preferences", "preferences"),
        ("server.routers.admin", "admin"),
    ):
        try:
            module = import_module(module_path)
        except ImportError as e:
            logger.warning("Server mode: %s router unavailable: %s", label, e)
            continue
        app.include_router(module.router)

    logger.info("WorkPilot server mode ACTIVE (multi-user, auth required)")
    return True
