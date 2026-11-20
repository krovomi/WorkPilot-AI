"""Microsoft Entra ID (OIDC) sign-in.

Flow (Authorization Code + PKCE, public client):
1. The Electron client opens the system browser on the Entra authorize URL
   with a loopback redirect (reusing the frontend's oauth-server.ts pattern)
   and a PKCE verifier it generated.
2. The client exchanges the authorization code against Entra's token
   endpoint directly (public client, PKCE — no secret involved).
3. The client POSTs the resulting ``id_token`` to ``/auth/oidc/exchange``.
4. This module validates the id_token against the tenant's JWKS, performs
   JIT user provisioning, and the router returns WorkPilot JWTs.

The server never sees the user's Entra password and needs no client secret.
"""

from __future__ import annotations

import logging
import threading

import jwt as pyjwt
from server.config import get_settings
from server.db.models import IdentityProvider, User, UserIdentity
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


class OidcError(Exception):
    pass


_jwk_client: pyjwt.PyJWKClient | None = None
_jwk_lock = threading.Lock()


def _get_jwk_client() -> pyjwt.PyJWKClient:
    """JWKS client for the tenant, cached (PyJWKClient caches keys itself)."""
    global _jwk_client
    settings = get_settings()
    if not settings.entra_enabled:
        raise OidcError("Entra ID sign-in is not configured on this server")
    with _jwk_lock:
        if _jwk_client is None:
            jwks_url = (
                f"https://login.microsoftonline.com/{settings.entra_tenant_id}"
                "/discovery/v2.0/keys"
            )
            _jwk_client = pyjwt.PyJWKClient(jwks_url, cache_keys=True)
        return _jwk_client


def reset_jwk_cache() -> None:
    """Tests only."""
    global _jwk_client
    _jwk_client = None


def validate_id_token(id_token: str) -> dict:
    """Validate an Entra id_token (signature, audience, issuer) -> claims."""
    settings = get_settings()
    try:
        signing_key = _get_jwk_client().get_signing_key_from_jwt(id_token)
        claims = pyjwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256"],
            audience=settings.entra_client_id,
            issuer=(
                f"https://login.microsoftonline.com/{settings.entra_tenant_id}/v2.0"
            ),
            options={"require": ["exp", "iss", "aud"]},
        )
    except OidcError:
        raise
    except pyjwt.PyJWTError as e:
        raise OidcError(f"Invalid Entra id_token: {type(e).__name__}") from e
    except Exception as e:  # JWKS fetch failures etc.
        raise OidcError(f"Could not validate id_token: {type(e).__name__}") from e

    if not claims.get("oid"):
        raise OidcError("id_token is missing the 'oid' claim")
    return claims


def _is_true(value: object) -> bool:
    return value is True or (isinstance(value, str) and value.lower() == "true")


def _address(value: object) -> str:
    if not isinstance(value, str) or "@" not in value:
        return ""
    return value.strip().lower()


def verified_email(claims: dict) -> str:
    """The address Entra vouches for in these claims, or ``""``.

    A member of the tenant signs in with their user principal name
    (``preferred_username``), whose domain the tenant itself has verified. A
    guest's ``preferred_username`` and any ``email`` claim come from another
    directory or from an editable attribute: they count only when Entra marks
    the address's domain as verified (the optional ``xms_edov`` claim).
    A guest is a token whose ``idp`` names another issuer, or whose optional
    ``acct`` claim is 1.
    """
    if _is_true(claims.get("xms_edov")):
        email = _address(claims.get("email"))
        if email:
            return email
    idp = claims.get("idp")
    member = idp in (None, "", claims.get("iss")) and str(claims.get("acct", 0)) != "1"
    return _address(claims.get("preferred_username")) if member else ""


async def provision_entra_user(db: AsyncSession, claims: dict) -> User:
    """JIT provisioning: find or create the user behind an Entra identity.

    Matching order:
    1. Existing identity (provider=entra, subject=oid) -> that user. The
       object id is stable within the tenant the server trusts.
    2. A verified address (``verified_email``) names an existing account that
       has no other Entra identity -> the identity is attached (lets a
       pre-created local/admin account link to SSO).
    3. A verified address and no account -> a new active member.
    An address Entra does not vouch for links and creates nothing.
    """
    oid = claims["oid"]
    identity = await db.scalar(
        select(UserIdentity).where(
            UserIdentity.provider == IdentityProvider.ENTRA.value,
            UserIdentity.subject == oid,
        )
    )
    if identity is not None:
        user = await db.get(User, identity.user_id)
        if user is None or not user.is_active:
            raise OidcError("Account is disabled")
        return user

    email = verified_email(claims)
    if not email:
        raise OidcError("Entra gave no verified email for this account")
    user = await db.scalar(select(User).where(User.email == email))
    if user is not None:
        if not user.is_active:
            raise OidcError("Account is disabled")
        if await _first_entra_subject(db, user.id) is not None:
            raise OidcError("This account is linked to another Entra sign-in")
    else:
        display_name = (claims.get("name") or email).strip()
        user = User(email=email, display_name=display_name)
        db.add(user)
        await db.flush()
        logger.info("JIT-provisioned Entra user %s", email)

    db.add(
        UserIdentity(
            user_id=user.id,
            provider=IdentityProvider.ENTRA.value,
            subject=oid,
        )
    )
    await db.commit()
    # Two first sign-ins for the same account may pass the check above at the
    # same time: the earliest link stays and the other is taken back.
    if await _first_entra_subject(db, user.id) != oid:
        await db.execute(
            delete(UserIdentity).where(
                UserIdentity.provider == IdentityProvider.ENTRA.value,
                UserIdentity.subject == oid,
            )
        )
        await db.commit()
        raise OidcError("This account is linked to another Entra sign-in")
    return user


async def _first_entra_subject(db: AsyncSession, user_id: str) -> str | None:
    """The Entra sign-in an account was linked to first, if any."""
    return await db.scalar(
        select(UserIdentity.subject)
        .where(
            UserIdentity.user_id == user_id,
            UserIdentity.provider == IdentityProvider.ENTRA.value,
        )
        .order_by(UserIdentity.created_at, UserIdentity.id)
        .limit(1)
    )
