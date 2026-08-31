"""Authentication endpoints: local login, Entra ID exchange, refresh, logout."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from server.auth.deps import CurrentUser, get_current_user, require_admin
from server.auth.jwt_tokens import (
    TokenError,
    issue_token_pair,
    revoke_refresh_token,
    rotate_refresh_token,
)
from server.auth.local import (
    LocalAuthError,
    authenticate_local,
    change_password,
    create_local_user,
)
from server.auth.oidc import OidcError, provision_entra_user, validate_id_token
from server.authz.engine import user_organizations
from server.authz.principal import get_principal
from server.authz.tenancy import can_act_in
from server.config import get_settings
from server.db.engine import get_db
from server.db.models import AuditLog, OrgMember, Role, User
from server.ratelimit import limiter
from server.schemas import (
    ChangePasswordRequest,
    CreateUserRequest,
    LoginRequest,
    LogoutRequest,
    MyPermissionsResponse,
    OidcExchangeRequest,
    OrganizationPublic,
    RefreshRequest,
    SwitchOrgRequest,
    TokenResponse,
    UserPublic,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_meta(request: Request) -> tuple[str | None, str | None]:
    ua = request.headers.get("user-agent")
    ip = request.client.host if request.client else None
    return ua, ip


async def _token_response(
    db: AsyncSession, user: User, request: Request
) -> TokenResponse:
    ua, ip = _client_meta(request)
    pair = await issue_token_pair(db, user, user_agent=ua, ip=ip)
    return TokenResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
        user=UserPublic.model_validate(user),
    )


@router.get("/config")
async def auth_config() -> dict:
    """Public: what login methods this server supports (drives the login UI)."""
    settings = get_settings()
    return {
        "local_enabled": True,
        "entra_enabled": settings.entra_enabled,
        "entra_tenant_id": settings.entra_tenant_id or None,
        "entra_client_id": settings.entra_client_id or None,
    }


@router.post("/login", response_model=TokenResponse)
@limiter.limit("10/minute")
async def login(
    body: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)
) -> TokenResponse:
    try:
        user = await authenticate_local(db, body.email, body.password)
    except LocalAuthError as e:
        raise HTTPException(status_code=401, detail=str(e))
    db.add(AuditLog(user_id=user.id, action="auth.login.local"))
    await db.commit()
    return await _token_response(db, user, request)


@router.post("/oidc/exchange", response_model=TokenResponse)
async def oidc_exchange(
    body: OidcExchangeRequest, request: Request, db: AsyncSession = Depends(get_db)
) -> TokenResponse:
    """Exchange a validated Entra id_token for WorkPilot tokens (JIT provisioning)."""
    try:
        claims = validate_id_token(body.id_token)
        user = await provision_entra_user(db, claims)
    except OidcError as e:
        raise HTTPException(status_code=401, detail=str(e))
    db.add(AuditLog(user_id=user.id, action="auth.login.entra"))
    await db.commit()
    return await _token_response(db, user, request)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(
    body: RefreshRequest, request: Request, db: AsyncSession = Depends(get_db)
) -> TokenResponse:
    ua, ip = _client_meta(request)
    try:
        pair, user = await rotate_refresh_token(
            db, body.refresh_token, user_agent=ua, ip=ip
        )
    except TokenError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return TokenResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
        user=UserPublic.model_validate(user),
    )


@router.post("/logout")
async def logout(body: LogoutRequest, db: AsyncSession = Depends(get_db)) -> dict:
    revoked = await revoke_refresh_token(db, body.refresh_token)
    return {"revoked": revoked}


@router.get("/me", response_model=UserPublic)
async def me(
    user: CurrentUser = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> UserPublic:
    db_user = await db.get(User, user.id)
    if db_user is None or not db_user.is_active:
        raise HTTPException(status_code=401, detail="Account is disabled or gone")
    return UserPublic.model_validate(db_user)


@router.get("/me/permissions", response_model=MyPermissionsResponse)
async def my_permissions(
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MyPermissionsResponse:
    """What the caller may do, in the organization they are acting in.

    The desktop app calls this once per session to decide what to show. It is
    presentation only — hiding a button is not a control, and every route
    re-checks the same permissions server-side.
    """
    principal = get_principal(request)
    orgs = await user_organizations(db, user.id)
    memberships = {
        row.org_id: row.slug
        for row in await db.execute(
            select(OrgMember.org_id, Role.slug).join(
                Role, Role.id == OrgMember.role_id
            ).where(OrgMember.user_id == user.id)
        )
    }

    org_list = []
    for org in orgs:
        item = OrganizationPublic.model_validate(org)
        item.my_role = memberships.get(org.id)
        org_list.append(item)

    return MyPermissionsResponse(
        user_id=user.id,
        platform_role=principal.platform_role,
        is_platform_admin=principal.is_platform_admin,
        org_id=principal.org_id,
        org_role=principal.org_role_slug,
        permissions=sorted(principal.permissions),
        organizations=org_list,
    )


@router.post("/switch-org", response_model=TokenResponse)
async def switch_org(
    body: SwitchOrgRequest,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """Re-mint a token bound to another organization the caller belongs to.

    Membership is verified here and again on every subsequent request, so a
    token naming an organization the user has since left grants nothing.
    """
    db_user = await db.get(User, user.id)
    if db_user is None or not db_user.is_active:
        raise HTTPException(status_code=401, detail="Account is disabled or gone")

    if not await can_act_in(db, user.id, db_user.role, body.org_id):
        raise HTTPException(
            status_code=403, detail="Not a member of that organization"
        )

    ua, ip = _client_meta(request)
    pair = await issue_token_pair(
        db, db_user, user_agent=ua, ip=ip, org_id=body.org_id
    )
    return TokenResponse(
        access_token=pair.access_token,
        refresh_token=pair.refresh_token,
        expires_in=pair.expires_in,
        user=UserPublic.model_validate(db_user),
    )


@router.post("/users", response_model=UserPublic, status_code=201)
async def create_user(
    body: CreateUserRequest,
    db: AsyncSession = Depends(get_db),
    admin: CurrentUser = Depends(require_admin),
) -> UserPublic:
    """Admin-only: create a local account."""
    try:
        user = await create_local_user(
            db,
            email=body.email,
            password=body.password,
            display_name=body.display_name,
            role=body.role,
        )
    except LocalAuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    db.add(
        AuditLog(
            user_id=admin.id, action="auth.user.created", payload={"email": user.email}
        )
    )
    await db.commit()
    return UserPublic.model_validate(user)


@router.post("/password")
async def update_password(
    body: ChangePasswordRequest,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    db_user = await db.get(User, user.id)
    if db_user is None:
        raise HTTPException(status_code=401, detail="Unknown user")
    try:
        await change_password(db, db_user, body.current_password, body.new_password)
    except LocalAuthError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"changed": True}
