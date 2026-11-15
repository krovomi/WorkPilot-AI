"""``/auth``: signing in, staying signed in, switching tenant, leaving.

Over HTTP through the real middleware: the tokens these routes hand out are
the ones the next requests carry.
"""

from __future__ import annotations

import time
import uuid

import jwt as pyjwt
import pytest

from tests.server_routes.world import World


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def login(world: World, who: str, password: str):
    return await world.client.post(
        "/auth/login", json={"email": f"{who}@example.com", "password": password}
    )


async def test_the_login_methods_are_public(world):
    answer = await world.call(None, "GET", "/auth/config")
    assert answer.json() == {
        "local_enabled": True,
        "entra_enabled": False,
        "entra_tenant_id": None,
        "entra_client_id": None,
    }


async def test_a_password_signs_in_and_the_token_acts_in_the_person_s_org(world):
    password = await world.give_password("contributor_a")
    answer = await login(world, "contributor_a", password)
    assert answer.status_code == 200, answer.text
    body = answer.json()
    assert body["user"]["email"] == "contributor_a@example.com"
    assert body["token_type"] == "bearer"
    me = await world.client.get(
        "/auth/me/permissions", headers=bearer(body["access_token"])
    )
    assert me.json()["org_id"] == world.orgs["a"]
    assert me.json()["org_role"] == "contributor"
    assert "task.write" in me.json()["permissions"]
    assert [o["slug"] for o in me.json()["organizations"]] == ["acme"]
    assert me.json()["organizations"][0]["my_role"] == "contributor"


async def test_a_wrong_password_and_an_unknown_email_get_the_same_answer(world):
    await world.give_password("contributor_a")
    wrong = await login(world, "contributor_a", "not-the-password-at-all")
    unknown = await login(world, "nobody-here", "not-the-password-at-all")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json() == {"detail": "Invalid email or password"}


async def test_a_deactivated_account_cannot_sign_in(world):
    password = await world.give_password("viewer_a")
    await world.ok(
        "admin_a", "POST", f"/admin/users/{world.users['viewer_a']}/deactivate"
    )
    answer = await login(world, "viewer_a", password)
    assert answer.status_code == 401
    assert answer.json()["detail"] == "Account is disabled"


async def test_logins_are_limited_per_address(world):
    await world.give_password("viewer_a")
    codes = [
        (await login(world, "viewer_a", "wrong-password-again")).status_code
        for _ in range(11)
    ]
    assert codes[:10] == [401] * 10
    assert codes[10] == 429


async def test_a_refresh_token_turns_once_and_its_replay_ends_every_session(world):
    password = await world.give_password("contributor_a")
    first = (await login(world, "contributor_a", password)).json()
    other = (await login(world, "contributor_a", password)).json()

    turned = await world.client.post(
        "/auth/refresh", json={"refresh_token": first["refresh_token"]}
    )
    assert turned.status_code == 200, turned.text
    assert turned.json()["refresh_token"] != first["refresh_token"]

    replay = await world.client.post(
        "/auth/refresh", json={"refresh_token": first["refresh_token"]}
    )
    assert replay.status_code == 401
    assert replay.json()["detail"] == "Refresh token was revoked"
    # The replay may be a thief's: every session of the account ends.
    for token in (turned.json()["refresh_token"], other["refresh_token"]):
        again = await world.client.post("/auth/refresh", json={"refresh_token": token})
        assert again.status_code == 401


async def test_an_unknown_refresh_token_is_refused(world):
    answer = await world.client.post(
        "/auth/refresh", json={"refresh_token": "never-issued"}
    )
    assert answer.status_code == 401
    assert answer.json()["detail"] == "Unknown refresh token"


async def test_a_refresh_token_of_a_deactivated_account_is_refused(world):
    password = await world.give_password("viewer_a")
    pair = (await login(world, "viewer_a", password)).json()
    from server.db.engine import get_session_factory
    from server.db.models import User

    async with get_session_factory()() as db:
        user = await db.get(User, world.users["viewer_a"])
        user.is_active = False
        await db.commit()
    answer = await world.client.post(
        "/auth/refresh", json={"refresh_token": pair["refresh_token"]}
    )
    assert answer.status_code == 401
    assert answer.json()["detail"] == "User is disabled or gone"


async def test_an_expired_refresh_token_is_refused(world):
    password = await world.give_password("viewer_a")
    pair = (await login(world, "viewer_a", password)).json()
    from datetime import UTC, datetime, timedelta

    from server.db.engine import get_session_factory
    from server.db.models import AuthSession
    from sqlalchemy import update

    async with get_session_factory()() as db:
        await db.execute(
            update(AuthSession).values(
                expires_at=datetime.now(UTC) - timedelta(minutes=1)
            )
        )
        await db.commit()
    answer = await world.client.post(
        "/auth/refresh", json={"refresh_token": pair["refresh_token"]}
    )
    assert answer.status_code == 401
    assert answer.json()["detail"] == "Refresh token expired"


async def test_logout_revokes_the_session_once(world):
    password = await world.give_password("viewer_a")
    pair = (await login(world, "viewer_a", password)).json()
    body = {"refresh_token": pair["refresh_token"]}
    assert (await world.client.post("/auth/logout", json=body)).json() == {
        "revoked": True
    }
    assert (await world.client.post("/auth/logout", json=body)).json() == {
        "revoked": False
    }
    refused = await world.client.post("/auth/refresh", json=body)
    assert refused.status_code == 401


async def test_me_is_the_account_and_a_deactivated_one_is_gone(world):
    me = await world.ok("viewer_a", "GET", "/auth/me")
    assert me["id"] == world.users["viewer_a"]
    token = await world.token("viewer_a")
    await world.ok(
        "admin_a", "POST", f"/admin/users/{world.users['viewer_a']}/deactivate"
    )
    # The access token is still within its lifetime; the account is not.
    answer = await world.client.get("/auth/me", headers=bearer(token))
    assert answer.status_code == 401


async def test_switching_to_an_organization_one_belongs_to(world):
    from server.db.engine import get_session_factory
    from server.db.models import OrgMember

    async with get_session_factory()() as db:
        db.add(
            OrgMember(
                org_id=world.orgs["b"],
                user_id=world.users["viewer_a"],
                role_id=world.roles["viewer"],
            )
        )
        await db.commit()
    # Two memberships: the token names the org it was minted for...
    switched = await world.ok(
        "viewer_a", "POST", "/auth/switch-org", json={"org_id": world.orgs["b"]}
    )
    me = await world.client.get(
        "/auth/me/permissions", headers=bearer(switched["access_token"])
    )
    assert me.json()["org_id"] == world.orgs["b"]
    assert {o["slug"] for o in me.json()["organizations"]} == {"acme", "globex"}
    # ... and the header picks the other one for one request.
    back = await world.client.get(
        "/auth/me/permissions",
        headers={
            **bearer(switched["access_token"]),
            "X-WorkPilot-Org": world.orgs["a"],
        },
    )
    assert back.json()["org_id"] == world.orgs["a"]


async def test_switching_to_an_organization_one_is_not_in_is_refused(world):
    answer = await world.call(
        "viewer_a", "POST", "/auth/switch-org", json={"org_id": world.orgs["b"]}
    )
    assert answer.status_code == 403
    assert answer.json()["detail"] == "Not a member of that organization"
    # The header is checked the same way: it does not move anyone across.
    me = await world.call(
        "viewer_a",
        "GET",
        "/auth/me/permissions",
        headers={"X-WorkPilot-Org": world.orgs["b"]},
    )
    assert me.json()["org_id"] == world.orgs["a"]


async def test_the_platform_administrator_acts_in_any_organization(world):
    switched = await world.ok(
        "platform", "POST", "/auth/switch-org", json={"org_id": world.orgs["b"]}
    )
    me = await world.client.get(
        "/auth/me/permissions", headers=bearer(switched["access_token"])
    )
    assert me.json()["org_id"] == world.orgs["b"]
    assert me.json()["is_platform_admin"] is True
    unknown = await world.call(
        "platform", "POST", "/auth/switch-org", json={"org_id": str(uuid.uuid4())}
    )
    assert unknown.status_code == 403


async def test_a_deactivated_account_cannot_switch(world):
    token = await world.token("viewer_a")
    from server.db.engine import get_session_factory
    from server.db.models import User

    async with get_session_factory()() as db:
        (await db.get(User, world.users["viewer_a"])).is_active = False
        await db.commit()
    answer = await world.client.post(
        "/auth/switch-org", json={"org_id": world.orgs["a"]}, headers=bearer(token)
    )
    # The middleware already refuses the deactivated account's token.
    assert answer.status_code == 401


async def test_only_the_platform_administrator_creates_accounts(world):
    password = "a-long-enough-password-" + uuid.uuid4().hex[:8]
    body = {
        "email": "newcomer@example.com",
        "password": password,
        "display_name": "Newcomer",
    }
    created = await world.call("platform", "POST", "/auth/users", json=body)
    assert created.status_code == 201, created.text
    assert created.json()["email"] == "newcomer@example.com"
    signed_in = await world.client.post(
        "/auth/login", json={"email": "newcomer@example.com", "password": password}
    )
    assert signed_in.status_code == 200
    again = await world.call("platform", "POST", "/auth/users", json=body)
    assert again.status_code == 400
    assert again.json()["detail"] == "A user with this email already exists"


@pytest.mark.parametrize(
    ("password", "detail"),
    [
        ("eleven-char", "Password must be at least 12 characters"),
        ("password1234", "This password is too common"),
        ("weakling-chosen@example.com", "Password must not match your email address"),
        ("weakling-chosen", "Password must not match your email address"),
    ],
)
async def test_a_weak_password_is_refused(world, password, detail):
    answer = await world.call(
        "platform",
        "POST",
        "/auth/users",
        json={
            "email": "weakling-chosen@example.com",
            "password": password,
            "display_name": "Weak",
        },
    )
    assert answer.status_code == 400, answer.text
    assert answer.json()["detail"] == detail


async def test_changing_one_s_password_ends_the_other_sessions(world):
    password = await world.give_password("contributor_a")
    pair = (await login(world, "contributor_a", password)).json()
    new = "a-new-and-long-password-" + uuid.uuid4().hex[:6]

    wrong = await world.call(
        "contributor_a",
        "POST",
        "/auth/password",
        json={"current_password": "not-the-current-one", "new_password": new},
    )
    assert wrong.status_code == 400
    assert wrong.json()["detail"] == "Current password is incorrect"

    changed = await world.ok(
        "contributor_a",
        "POST",
        "/auth/password",
        json={"current_password": password, "new_password": new},
    )
    assert changed == {"changed": True}
    stale = await world.client.post(
        "/auth/refresh", json={"refresh_token": pair["refresh_token"]}
    )
    assert stale.status_code == 401
    assert (await login(world, "contributor_a", password)).status_code == 401
    assert (await login(world, "contributor_a", new)).status_code == 200


async def test_an_account_without_a_local_password_cannot_change_it(world):
    answer = await world.call(
        "viewer_a",
        "POST",
        "/auth/password",
        json={
            "current_password": "whatever-it-was",
            "new_password": "a-new-and-long-password",
        },
    )
    assert answer.status_code == 400
    assert answer.json()["detail"] == "This account has no local password"


async def test_an_access_token_past_its_lifetime_is_refused(world):
    from server.config import get_settings

    settings = get_settings()
    now = int(time.time())
    expired = pyjwt.encode(
        {
            "iss": settings.jwt_issuer,
            "sub": world.users["owner_a"],
            "iat": now - 3600,
            "exp": now - 60,
        },
        settings.jwt_secret,
        algorithm="HS256",
    )
    answer = await world.client.get("/auth/me", headers=bearer(expired))
    assert answer.status_code == 401
    assert answer.json()["detail"] == "Invalid or expired token"


class TestEntraSignIn:
    """``/auth/oidc/exchange``: an id_token signed by the tenant's key.

    The tenant's JWKS endpoint is the one thing not reached: its key is the
    test's own RSA key, handed to the validator in place of the download.
    """

    TENANT = "11111111-2222-3333-4444-555555555555"
    CLIENT = "66666666-7777-8888-9999-000000000000"

    @pytest.fixture
    def entra(self, monkeypatch):
        from cryptography.hazmat.primitives.asymmetric import rsa
        from server import config as server_config
        from server.auth import oidc

        monkeypatch.setenv("WORKPILOT_ENTRA_TENANT_ID", self.TENANT)
        monkeypatch.setenv("WORKPILOT_ENTRA_CLIENT_ID", self.CLIENT)
        server_config.reset_settings_cache()
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

        class _Jwks:
            def get_signing_key_from_jwt(self, token):
                header = pyjwt.get_unverified_header(token)
                if header.get("kid") != "tenant-key":
                    raise pyjwt.PyJWKClientError("Unable to find a signing key")
                return type("Key", (), {"key": key.public_key()})()

        monkeypatch.setattr(oidc, "_jwk_client", _Jwks())
        yield key
        oidc.reset_jwk_cache()

    def id_token(self, key, kid: str = "tenant-key", **claims) -> str:
        now = int(time.time())
        payload = {
            "iss": f"https://login.microsoftonline.com/{self.TENANT}/v2.0",
            "aud": self.CLIENT,
            "iat": now,
            "exp": now + 300,
            "oid": "entra-object-1",
            "preferred_username": "Grace@Example.com",
            "name": "Grace",
            **claims,
        }
        payload = {k: v for k, v in payload.items() if v is not None}
        return pyjwt.encode(payload, key, algorithm="RS256", headers={"kid": kid})

    async def exchange(self, world, token: str):
        return await world.client.post("/auth/oidc/exchange", json={"id_token": token})

    async def test_the_config_says_entra_is_on(self, world, entra):
        config = (await world.call(None, "GET", "/auth/config")).json()
        assert config["entra_enabled"] is True
        assert config["entra_tenant_id"] == self.TENANT

    async def test_a_new_person_is_provisioned_once(self, world, entra):
        first = await self.exchange(world, self.id_token(entra))
        assert first.status_code == 200, first.text
        assert first.json()["user"]["email"] == "grace@example.com"
        again = await self.exchange(world, self.id_token(entra))
        assert again.json()["user"]["id"] == first.json()["user"]["id"]

    async def test_an_existing_account_with_the_email_is_linked(self, world, entra):
        token = self.id_token(entra, preferred_username="viewer_a@example.com")
        answer = await self.exchange(world, token)
        assert answer.status_code == 200, answer.text
        assert answer.json()["user"]["id"] == world.users["viewer_a"]

    @pytest.mark.parametrize(
        ("claims", "detail"),
        [
            ({"aud": "another-app"}, "Invalid Entra id_token: InvalidAudienceError"),
            (
                {"iss": "https://login.microsoftonline.com/other/v2.0"},
                "Invalid Entra id_token: InvalidIssuerError",
            ),
            ({"exp": 1}, "Invalid Entra id_token: ExpiredSignatureError"),
            ({"oid": None}, "id_token is missing the 'oid' claim"),
            (
                {"preferred_username": None, "oid": "entra-object-2"},
                "Entra id_token carries no usable email claim",
            ),
        ],
    )
    async def test_a_bad_id_token_is_refused(self, world, entra, claims, detail):
        answer = await self.exchange(world, self.id_token(entra, **claims))
        assert answer.status_code == 401
        assert answer.json()["detail"] == detail

    async def test_a_token_signed_by_another_key_is_refused(self, world, entra):
        from cryptography.hazmat.primitives.asymmetric import rsa

        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        answer = await self.exchange(world, self.id_token(other))
        assert answer.status_code == 401
        assert answer.json()["detail"] == (
            "Invalid Entra id_token: InvalidSignatureError"
        )

    async def test_a_key_the_tenant_does_not_publish_is_refused(self, world, entra):
        answer = await self.exchange(world, self.id_token(entra, kid="unknown"))
        assert answer.status_code == 401
        assert answer.json()["detail"] == "Invalid Entra id_token: PyJWKClientError"

    async def test_a_deactivated_account_cannot_sign_in(self, world, entra):
        await self.exchange(world, self.id_token(entra))
        from server.db.engine import get_session_factory
        from server.db.models import User
        from sqlalchemy import select

        async with get_session_factory()() as db:
            user = await db.scalar(
                select(User).where(User.email == "grace@example.com")
            )
            user.is_active = False
            await db.commit()
        by_identity = await self.exchange(world, self.id_token(entra))
        assert by_identity.json()["detail"] == "Account is disabled"
        by_email = await self.exchange(
            world, self.id_token(entra, oid="entra-object-3")
        )
        assert by_email.json()["detail"] == "Account is disabled"


async def test_entra_is_refused_when_the_server_does_not_offer_it(world):
    answer = await world.client.post(
        "/auth/oidc/exchange", json={"id_token": "header.payload.signature"}
    )
    assert answer.status_code == 401
    assert answer.json()["detail"] == (
        "Entra ID sign-in is not configured on this server"
    )
