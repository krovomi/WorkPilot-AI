"""Sign-in with any OpenID Connect provider (Okta, Google, Keycloak, Auth0...).

The same flow as Microsoft Entra ID (``server/auth/oidc.py``): the client runs
Authorization Code + PKCE in the system browser as a public client, then POSTs
the ``id_token`` to ``/auth/sso/exchange``; this module validates it and finds
or creates the person behind it. Where Entra's endpoints are fixed, a generic
provider is read from its discovery document
(``<issuer>/.well-known/openid-configuration``), checked before use:

- its ``issuer`` is exactly the configured one, and every endpoint is an https
  URL (http only on loopback, for a Keycloak on the same machine);
- an id_token is signed with an asymmetric algorithm the provider announces
  (never ``none`` nor a shared-secret HMAC), for this server's client, by this
  issuer, and is not expired; several audiences need ``azp`` to be ours.

A person is matched by the provider's subject, scoped to its issuer. An email
links to an existing account, or names a new one, only when the provider says
it verified it (``email_verified``): an unverified address could be anyone's.
The server needs no client secret and never sees a password.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
import time
from typing import Any

import httpx
import jwt as pyjwt
from server.auth.oidc import OidcError
from server.config import get_settings, oidc_url
from server.db.models import IdentityProvider, User, UserIdentity
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

#: Asymmetric JWS algorithms an id_token may use (RFC 7518, RFC 8037).
SIGNING_ALGORITHMS = frozenset(
    {
        "RS256",
        "RS384",
        "RS512",
        "PS256",
        "PS384",
        "PS512",
        "ES256",
        "ES384",
        "ES512",
        "EdDSA",
    }
)
#: How long a discovery document is kept before it is read again.
DISCOVERY_TTL_SECONDS = 3600
MAX_DISCOVERY_BYTES = 512_000
#: ``user_identities.subject`` holds the issuer and the subject together.
MAX_SUBJECT = 320

_lock = threading.Lock()
_discovery: dict[str, Any] | None = None
_discovered_at = 0.0
_jwk_client: pyjwt.PyJWKClient | None = None


def reset_cache() -> None:
    """Forget the discovery document and the key client (tests, config change)."""
    global _discovery, _discovered_at, _jwk_client
    with _lock:
        _discovery = None
        _discovered_at = 0.0
        _jwk_client = None


def _fetch_discovery(issuer: str) -> dict[str, Any]:
    url = f"{issuer}/.well-known/openid-configuration"
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            response = client.get(url, headers={"Accept": "application/json"})
    except httpx.HTTPError as e:
        raise OidcError(
            f"The identity provider cannot be reached: {type(e).__name__}"
        ) from e
    if response.status_code != 200 or len(response.content) > MAX_DISCOVERY_BYTES:
        raise OidcError("The identity provider has no usable discovery document")
    try:
        document = json.loads(response.content)
    except ValueError as e:
        raise OidcError("The identity provider has no usable discovery document") from e
    if not isinstance(document, dict):
        raise OidcError("The identity provider has no usable discovery document")
    return document


def _checked(document: dict[str, Any], issuer: str) -> dict[str, Any]:
    """The parts of a discovery document this server uses, each checked."""
    announced = document.get("issuer")
    if not isinstance(announced, str) or announced.rstrip("/") != issuer:
        raise OidcError("The discovery document names another issuer")
    endpoints: dict[str, Any] = {}
    for key in ("authorization_endpoint", "token_endpoint", "jwks_uri"):
        value = document.get(key)
        url = oidc_url(value) if isinstance(value, str) else ""
        if not url:
            raise OidcError(f"The discovery document has no usable {key}")
        endpoints[key] = url
    raw = document.get("id_token_signing_alg_values_supported") or ["RS256"]
    algorithms = sorted(
        a for a in raw if isinstance(a, str) and a in SIGNING_ALGORITHMS
    )
    if not algorithms:
        raise OidcError("The identity provider signs with no accepted algorithm")
    endpoints["algorithms"] = algorithms
    return endpoints


def discover() -> dict[str, Any]:
    """The configured provider's endpoints and algorithms (cached for an hour)."""
    global _discovery, _discovered_at, _jwk_client
    settings = get_settings()
    if not settings.oidc_enabled:
        raise OidcError("Single sign-on is not configured on this server")
    with _lock:
        fresh = time.monotonic() - _discovered_at < DISCOVERY_TTL_SECONDS
        if _discovery is not None and fresh:
            return _discovery
    discovered = _checked(_fetch_discovery(settings.oidc_issuer), settings.oidc_issuer)
    with _lock:
        if _discovery is None or _discovery["jwks_uri"] != discovered["jwks_uri"]:
            _jwk_client = pyjwt.PyJWKClient(discovered["jwks_uri"], cache_keys=True)
        _discovery, _discovered_at = discovered, time.monotonic()
        return discovered


def _keys() -> pyjwt.PyJWKClient:
    discover()
    with _lock:
        assert _jwk_client is not None  # set by discover()
        return _jwk_client


def validate_id_token(id_token: str) -> dict[str, Any]:
    """Validate an id_token of the configured provider -> its claims."""
    settings = get_settings()
    algorithms = discover()["algorithms"]
    try:
        signing_key = _keys().get_signing_key_from_jwt(id_token)
        claims = pyjwt.decode(
            id_token,
            signing_key.key,
            algorithms=algorithms,
            audience=settings.oidc_client_id,
            issuer=settings.oidc_issuer,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
    except pyjwt.PyJWTError as e:  # PyJWKClientError included
        raise OidcError(f"Invalid id_token: {type(e).__name__}") from e
    audience = claims["aud"]
    if isinstance(audience, list) and len(audience) > 1:
        if claims.get("azp") != settings.oidc_client_id:
            raise OidcError("Invalid id_token: another party is authorized")
    if not isinstance(claims["sub"], str) or not claims["sub"]:
        raise OidcError("id_token is missing the 'sub' claim")
    return claims


async def avalidate_id_token(id_token: str) -> dict[str, Any]:
    """:func:`validate_id_token` off the event loop: it may read the network."""
    return await asyncio.to_thread(validate_id_token, id_token)


def _verified_email(claims: dict[str, Any]) -> str:
    verified = claims.get("email_verified")
    if verified is not True and str(verified).lower() != "true":
        return ""
    email = claims.get("email")
    return email.strip().lower() if isinstance(email, str) else ""


async def provision_oidc_user(db: AsyncSession, claims: dict[str, Any]) -> User:
    """Find or create the person behind an identity of the configured provider.

    1. The identity (issuer and subject) is known -> its person.
    2. A verified email names an existing account -> the identity is attached.
    3. A verified email and no account -> a new active member.
    """
    subject = f"{get_settings().oidc_issuer}|{claims['sub']}"
    if len(subject) > MAX_SUBJECT:
        raise OidcError("The identity provider's subject is too long")
    identity = await db.scalar(
        select(UserIdentity).where(
            UserIdentity.provider == IdentityProvider.OIDC.value,
            UserIdentity.subject == subject,
        )
    )
    if identity is not None:
        user = await db.get(User, identity.user_id)
        if user is None or not user.is_active:
            raise OidcError("Account is disabled")
        return user

    email = _verified_email(claims)
    if not email:
        raise OidcError("The identity provider gave no verified email")
    user = await db.scalar(select(User).where(User.email == email))
    if user is not None and not user.is_active:
        raise OidcError("Account is disabled")
    if user is None:
        name = claims.get("name")
        display_name = name.strip() if isinstance(name, str) and name.strip() else email
        user = User(email=email, display_name=display_name[:200])
        db.add(user)
        await db.flush()
        logger.info("JIT-provisioned a single sign-on user")
    db.add(
        UserIdentity(
            user_id=user.id, provider=IdentityProvider.OIDC.value, subject=subject
        )
    )
    await db.commit()
    return user
