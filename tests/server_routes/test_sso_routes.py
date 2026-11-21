"""``/auth/sso/exchange``: signing in with any OpenID Connect provider.

Over HTTP through the real middleware. The provider is never reached: its
discovery document is served by the test, and its key set is the test's own
RSA key, handed to the validator in place of the download.
"""

from __future__ import annotations

import time

import jwt as pyjwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

ISSUER = "https://login.example.test/oauth2/default"
CLIENT = "0oa-workpilot-desktop"

DOCUMENT = {
    "issuer": ISSUER,
    "authorization_endpoint": f"{ISSUER}/v1/authorize",
    "token_endpoint": f"{ISSUER}/v1/token",
    "jwks_uri": f"{ISSUER}/v1/keys",
    "id_token_signing_alg_values_supported": ["RS256"],
}


@pytest.fixture
def provider(monkeypatch):
    from server import config as server_config
    from server.auth import oidc_generic

    monkeypatch.setenv("WORKPILOT_OIDC_ISSUER", ISSUER)
    monkeypatch.setenv("WORKPILOT_OIDC_CLIENT_ID", CLIENT)
    monkeypatch.setenv("WORKPILOT_OIDC_NAME", "Okta")
    server_config.reset_settings_cache()
    oidc_generic.reset_cache()
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class Keys:
        def __init__(self, uri, cache_keys):
            assert uri == DOCUMENT["jwks_uri"]

        def get_signing_key_from_jwt(self, token):
            if pyjwt.get_unverified_header(token).get("kid") != "idp-key":
                raise pyjwt.PyJWKClientError("Unable to find a signing key")
            return type("Key", (), {"key": key.public_key()})()

    monkeypatch.setattr(oidc_generic, "_fetch_discovery", lambda issuer: DOCUMENT)
    monkeypatch.setattr(oidc_generic.pyjwt, "PyJWKClient", Keys)
    yield key
    oidc_generic.reset_cache()


def id_token(key, kid: str = "idp-key", algorithm: str = "RS256", **claims) -> str:
    now = int(time.time())
    payload = {
        "iss": ISSUER,
        "aud": CLIENT,
        "iat": now,
        "exp": now + 300,
        "sub": "00u-ada",
        "email": "Ada@Example.com",
        "email_verified": True,
        "name": "Ada",
        **claims,
    }
    payload = {k: v for k, v in payload.items() if v is not None}
    return pyjwt.encode(payload, key, algorithm=algorithm, headers={"kid": kid})


async def exchange(world, token: str):
    return await world.client.post("/auth/sso/exchange", json={"id_token": token})


async def test_the_config_gives_the_client_what_it_runs(world, provider):
    config = (await world.call(None, "GET", "/auth/config")).json()
    assert config["sso_enabled"] is True
    assert config["sso_name"] == "Okta"
    assert config["sso_client_id"] == CLIENT
    assert config["sso_scopes"] == "openid profile email"
    assert config["sso_authorization_endpoint"] == f"{ISSUER}/v1/authorize"
    assert config["sso_token_endpoint"] == f"{ISSUER}/v1/token"


async def test_an_unusable_provider_shows_no_button(world, provider, monkeypatch):
    from server.auth import oidc_generic
    from server.auth.oidc import OidcError

    def unreachable(issuer):
        raise OidcError("The identity provider cannot be reached: ConnectError")

    monkeypatch.setattr(oidc_generic, "_fetch_discovery", unreachable)
    config = (await world.call(None, "GET", "/auth/config")).json()
    assert config["sso_enabled"] is False and "sso_name" not in config
    answer = await exchange(world, id_token(provider))
    assert answer.status_code == 401
    assert answer.json()["detail"] == (
        "The identity provider cannot be reached: ConnectError"
    )


async def test_without_sso_the_exchange_is_refused(world):
    answer = await exchange(world, "a.b.c")
    assert answer.status_code == 401
    assert answer.json()["detail"] == "Single sign-on is not configured on this server"


async def test_a_new_person_is_provisioned_once_and_audited(world, provider):
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog, UserIdentity
    from sqlalchemy import select

    first = await exchange(world, id_token(provider))
    assert first.status_code == 200, first.text
    assert first.json()["user"]["email"] == "ada@example.com"
    assert first.json()["user"]["display_name"] == "Ada"
    # Known by its subject now: a later token without a verified email works.
    again = await exchange(world, id_token(provider, email_verified=None))
    assert again.json()["user"]["id"] == first.json()["user"]["id"]
    async with get_session_factory()() as db:
        identity = await db.scalar(
            select(UserIdentity).where(UserIdentity.provider == "oidc")
        )
        actions = list(await db.scalars(select(AuditLog.action)))
    assert identity.subject == f"{ISSUER}|00u-ada"
    assert actions.count("auth.login.oidc") == 2


async def test_a_verified_email_links_the_existing_account(world, provider):
    token = id_token(provider, sub="00u-viewer", email="viewer_a@example.com")
    answer = await exchange(world, token)
    assert answer.status_code == 200, answer.text
    assert answer.json()["user"]["id"] == world.users["viewer_a"]


async def test_a_string_true_counts_as_verified(world, provider):
    answer = await exchange(world, id_token(provider, email_verified="true", name=" "))
    assert answer.status_code == 200, answer.text
    assert answer.json()["user"]["display_name"] == "ada@example.com"


@pytest.mark.parametrize("verified", [False, None, "false", "yes"])
async def test_an_unverified_email_neither_links_nor_creates(world, provider, verified):
    token = id_token(
        provider, sub="00u-x", email="viewer_a@example.com", email_verified=verified
    )
    answer = await exchange(world, token)
    assert answer.status_code == 401
    assert answer.json()["detail"] == "The identity provider gave no verified email"


async def test_an_email_that_is_not_a_string_is_no_email(world, provider):
    answer = await exchange(world, id_token(provider, email=["ada@example.com"]))
    assert answer.status_code == 401
    assert answer.json()["detail"] == "The identity provider gave no verified email"


async def test_a_disabled_account_cannot_sign_in(world, provider):
    first = await exchange(
        world, id_token(provider, sub="00u-v", email="viewer_a@example.com")
    )
    assert first.status_code == 200
    await world.ok(
        "admin_a", "POST", f"/admin/users/{world.users['viewer_a']}/deactivate"
    )
    # By its known identity, and by email for an identity not seen before.
    for sub in ("00u-v", "00u-w"):
        answer = await exchange(
            world, id_token(provider, sub=sub, email="viewer_a@example.com")
        )
        assert answer.status_code == 401
        assert answer.json()["detail"] == "Account is disabled"


@pytest.mark.parametrize(
    ("claims", "detail"),
    [
        ({"aud": "another-app"}, "Invalid id_token: InvalidAudienceError"),
        (
            {"iss": "https://login.example.test/other"},
            "Invalid id_token: InvalidIssuerError",
        ),
        ({"exp": 1}, "Invalid id_token: ExpiredSignatureError"),
        ({"sub": None}, "Invalid id_token: MissingRequiredClaimError"),
        ({"sub": ""}, "id_token is missing the 'sub' claim"),
        (
            {"aud": [CLIENT, "another-app"]},
            "Invalid id_token: another party is authorized",
        ),
        ({"sub": "s" * 300}, "The identity provider's subject is too long"),
    ],
)
async def test_a_bad_id_token_is_refused(world, provider, claims, detail):
    answer = await exchange(world, id_token(provider, **claims))
    assert answer.status_code == 401
    assert answer.json()["detail"] == detail


async def test_several_audiences_need_ours_as_the_authorized_party(world, provider):
    token = id_token(provider, aud=[CLIENT, "another-app"], azp=CLIENT)
    assert (await exchange(world, token)).status_code == 200


async def test_a_token_the_provider_did_not_sign_is_refused(world, provider):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    for token, detail in (
        (id_token(other), "Invalid id_token: InvalidSignatureError"),
        (id_token(provider, kid="unknown"), "Invalid id_token: PyJWKClientError"),
        (
            id_token("a-shared-secret-of-32-bytes-long!", algorithm="HS256"),
            "Invalid id_token: InvalidAlgorithmError",
        ),
    ):
        answer = await exchange(world, token)
        assert answer.status_code == 401
        assert answer.json()["detail"] == detail


async def test_an_oversized_token_is_refused_before_any_check(world):
    answer = await exchange(world, "x" * 20_000)
    assert answer.status_code == 422
