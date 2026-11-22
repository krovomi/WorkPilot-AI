"""A sign-in: its refresh session, its tokens and its line in the audit log.

Each sign-in gets an id (``jwt_tokens.new_login``) that every access token and
refresh session issued from it carries, and that every audit entry written
under it names (``services/audit.py``). Its own line is written in the
organization the tokens act in, so that organization's history
(``GET /admin/audit``) shows who signed in, how and from where, then what was
done in that session. A sign-in through an identity provider names it there
(its name and issuer, as configured at that moment), and
:func:`session_of` describes the caller's own sign-in from that line
(``GET /auth/me/session``).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from server.auth.jwt_tokens import (
    LOGIN_METHODS,
    Login,
    TokenPair,
    issue_token_pair,
    new_login,
)
from server.config import get_settings
from server.db.models import AuditLog, User
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: The name Microsoft Entra ID is shown by (the generic provider has its own).
ENTRA_NAME = "Microsoft Entra ID"
#: What a description keeps of a provider's name and of its issuer's host.
MAX_NAME = 80
MAX_HOST = 253
LOGIN_ACTIONS = tuple(sorted(f"auth.login.{method}" for method in LOGIN_METHODS))


def provider_of(method: str | None) -> dict[str, str] | None:
    """The identity provider a sign-in by ``method`` goes through, as the server
    is configured now: its name and its issuer. None for a password or an
    invitation, and for a provider no longer configured."""
    settings = get_settings()
    if method == "entra" and settings.entra_enabled:
        issuer = f"https://login.microsoftonline.com/{settings.entra_tenant_id}/v2.0"
        return {"name": ENTRA_NAME, "issuer": issuer}
    if method == "oidc" and settings.oidc_enabled:
        return {"name": settings.oidc_name, "issuer": settings.oidc_issuer}
    return None


async def signed_in(
    db: AsyncSession,
    user: User,
    *,
    method: str,
    user_agent: str | None,
    ip: str | None,
) -> TokenPair:
    """Open a new sign-in by ``method`` (``jwt_tokens.LOGIN_METHODS``)."""
    login = new_login(method)
    pair = await issue_token_pair(db, user, user_agent=user_agent, ip=ip, login=login)
    provider = provider_of(method)
    db.add(
        AuditLog(
            user_id=user.id,
            org_id=pair.org_id,
            action=f"auth.login.{method}",
            ip=(ip or "")[:64] or None,
            user_agent=(user_agent or "")[:400] or None,
            login_id=login.id,
            login_method=method,
            # Which provider, as configured now: a later change of it does
            # not rename this sign-in.
            payload=provider,
        )
    )
    await db.commit()
    return pair


def _host(issuer: object) -> str | None:
    if not isinstance(issuer, str):
        return None
    try:
        host = urlsplit(issuer).hostname
    except ValueError:
        return None
    return host[:MAX_HOST] if host else None


async def session_of(
    db: AsyncSession, user_id: str, login: Login | None
) -> dict[str, Any]:
    """How the caller's current session was opened: the method, the provider
    (its name and its issuer's host) and when, from the sign-in's own line in
    the audit log. A token from before sign-ins had ids names none of it; a
    line from before providers were recorded gives the provider configured
    now for its method."""
    if login is None:
        return {
            "login_id": None,
            "method": None,
            "provider_name": None,
            "issuer_host": None,
            "signed_in_at": None,
        }
    entry = await db.scalar(
        select(AuditLog)
        .where(
            AuditLog.login_id == login.id,
            AuditLog.user_id == user_id,
            AuditLog.action.in_(LOGIN_ACTIONS),
        )
        .order_by(AuditLog.created_at)
        .limit(1)
    )
    recorded = entry.payload if entry is not None else None
    provider = recorded if isinstance(recorded, dict) else provider_of(login.method)
    name = provider.get("name") if provider else None
    signed_in_at: datetime | None = entry.created_at if entry is not None else None
    return {
        "login_id": login.id,
        "method": login.method,
        "provider_name": name[:MAX_NAME] if isinstance(name, str) and name else None,
        "issuer_host": _host(provider.get("issuer")) if provider else None,
        "signed_in_at": signed_in_at,
    }
