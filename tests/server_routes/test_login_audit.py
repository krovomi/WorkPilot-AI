"""The audit log names the sign-in each action was made under.

A sign-in (password, Entra, the OpenID Connect provider, an accepted
invitation) gets an id; every token and refresh session that follow from it
carry that id and how the person signed in, and the organization's history
(``GET /admin/audit``) lists the sign-in, then what was done under it.
"""

from __future__ import annotations

import jwt as pyjwt
import pytest

from tests.server_routes.world import World


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def sign_in(world: World, who: str) -> dict:
    password = await world.give_password(who)
    answer = await world.client.post(
        "/auth/login", json={"email": f"{who}@example.com", "password": password}
    )
    assert answer.status_code == 200, answer.text
    return answer.json()


def claims(token: str) -> dict:
    return pyjwt.decode(token, options={"verify_signature": False})


async def history(world: World, **params: str) -> list[dict]:
    answer = await world.call("admin_a", "GET", "/admin/audit", params=params)
    assert answer.status_code == 200, answer.text
    return answer.json()


async def test_a_sign_in_and_what_it_does_share_one_id(world):
    body = await sign_in(world, "admin_a")
    token = claims(body["access_token"])
    login_id = token["sid"]
    assert token["amr"] == "local"
    created = await world.client.post(
        "/admin/groups",
        json={"name": "Reviewers"},
        headers=bearer(body["access_token"]),
    )
    assert created.status_code == 201, created.text
    # A refresh keeps the sign-in.
    renewed = await world.client.post(
        "/auth/refresh", json={"refresh_token": body["refresh_token"]}
    )
    assert claims(renewed.json()["access_token"])["sid"] == login_id
    entries = await history(world, login_id=login_id)
    assert [(e["action"], e["login_method"]) for e in entries] == [
        ("org.group.created", "local"),
        ("auth.login.local", "local"),
    ]
    assert {e["login_id"] for e in entries} == {login_id}
    assert entries[1]["ip"]
    # The session the admin page lists names the same sign-in.
    sessions = await world.ok(
        "admin_a", "GET", "/admin/sessions", params={"user_id": world.users["admin_a"]}
    )
    assert [(s["login_id"], s["login_method"]) for s in sessions] == [
        (login_id, "local")
    ]


async def test_a_token_minted_before_sign_ins_had_ids_writes_none(world):
    # The world's tokens are minted directly, as an older server's were.
    created = await world.call("admin_a", "POST", "/admin/groups", json={"name": "Ops"})
    assert created.status_code == 201, created.text
    [entry] = await history(world, action="org.group.created")
    assert entry["login_id"] is None and entry["login_method"] is None
    # Switching organization from such a token starts a sign-in id, method unknown.
    switched = await world.ok(
        "platform", "POST", "/auth/switch-org", json={"org_id": world.orgs["b"]}
    )
    token = claims(switched["access_token"])
    assert token["sid"] and "amr" not in token


async def test_switching_organization_keeps_the_sign_in(world):
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
    body = await sign_in(world, "viewer_a")
    switched = await world.client.post(
        "/auth/switch-org",
        json={"org_id": world.orgs["b"]},
        headers=bearer(body["access_token"]),
    )
    assert switched.status_code == 200, switched.text
    before, after = (
        claims(body["access_token"]),
        claims(switched.json()["access_token"]),
    )
    assert (after["sid"], after["amr"]) == (before["sid"], "local")


async def test_a_refresh_session_from_before_gets_a_sign_in_id(world):
    from server.db.engine import get_session_factory
    from server.db.models import AuthSession
    from sqlalchemy import update

    body = await sign_in(world, "viewer_a")
    async with get_session_factory()() as db:
        await db.execute(update(AuthSession).values(login_id=None, login_method=None))
        await db.commit()
    renewed = await world.client.post(
        "/auth/refresh", json={"refresh_token": body["refresh_token"]}
    )
    token = claims(renewed.json()["access_token"])
    assert token["sid"] != claims(body["access_token"])["sid"]
    assert "amr" not in token


def test_only_the_server_s_own_sign_in_claims_are_read():
    from server.auth.jwt_tokens import Login, login_of, new_login

    assert login_of({"sid": "s-1", "amr": "oidc"}) == Login(id="s-1", method="oidc")
    assert login_of({"sid": "s-1", "amr": "magic"}) == Login(id="s-1", method=None)
    for bad in ({}, {"sid": ""}, {"sid": "x" * 37}, {"sid": 7}):
        assert login_of(bad) is None
    assert new_login("entra").method == "entra"
    with pytest.raises(ValueError):
        new_login("magic")


async def test_the_person_reads_how_their_session_was_opened(world):
    body = await sign_in(world, "viewer_a")
    answer = await world.client.get(
        "/auth/me/session", headers=bearer(body["access_token"])
    )
    assert answer.status_code == 200, answer.text
    session = answer.json()
    assert session["login_id"] == claims(body["access_token"])["sid"]
    assert session["method"] == "local"
    assert session["provider_name"] is None and session["issuer_host"] is None
    assert session["signed_in_at"]
    assert session["user"]["email"] == "viewer_a@example.com"


async def test_a_session_from_before_sign_ins_had_ids_names_nothing(world):
    session = await world.ok("viewer_a", "GET", "/auth/me/session")
    assert session["user"]["id"] == world.users["viewer_a"]
    assert [session[k] for k in ("login_id", "method", "signed_in_at")] == [
        None,
        None,
        None,
    ]
    # Switching organization from such a token: an id, no method, no line.
    switched = await world.ok(
        "platform", "POST", "/auth/switch-org", json={"org_id": world.orgs["b"]}
    )
    answer = await world.client.get(
        "/auth/me/session", headers=bearer(switched["access_token"])
    )
    session = answer.json()
    assert session["login_id"] == claims(switched["access_token"])["sid"]
    assert session["method"] is None and session["signed_in_at"] is None


async def test_a_deactivated_account_reads_no_session(world):
    from types import SimpleNamespace

    from fastapi import HTTPException
    from server.auth.deps import CurrentUser
    from server.db.engine import get_session_factory
    from server.db.models import User
    from server.routers.auth import my_session

    token = await world.token("viewer_a")
    await world.ok(
        "admin_a", "POST", f"/admin/users/{world.users['viewer_a']}/deactivate"
    )
    answer = await world.client.get("/auth/me/session", headers=bearer(token))
    assert answer.status_code == 401
    # The route itself refuses too, whatever the middleware let through.
    async with get_session_factory()() as db:
        user = await db.get(User, world.users["viewer_a"])
        caller = CurrentUser(
            id=user.id, email=user.email, role=user.role, display_name="x"
        )
        request = SimpleNamespace(state=SimpleNamespace())
        with pytest.raises(HTTPException) as refused:
            await my_session(request, caller, db)  # type: ignore[arg-type]
    assert refused.value.status_code == 401


async def test_a_sign_in_recorded_without_its_provider_gives_today_s(
    world, monkeypatch
):
    from server import config as server_config
    from server.auth.jwt_tokens import Login
    from server.auth.sign_in import session_of
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog

    user_id = world.users["viewer_a"]
    async with get_session_factory()() as db:
        db.add(
            AuditLog(
                user_id=user_id,
                action="auth.login.entra",
                login_id="old-entra-sign-in",
                login_method="entra",
            )
        )
        await db.commit()
        login = Login(id="old-entra-sign-in", method="entra")
        # Entra no longer configured: the sign-in keeps its method only.
        gone = await session_of(db, user_id, login)
        assert (gone["method"], gone["provider_name"], gone["issuer_host"]) == (
            "entra",
            None,
            None,
        )
        assert gone["signed_in_at"] is not None
        monkeypatch.setenv(
            "WORKPILOT_ENTRA_TENANT_ID", "11111111-2222-3333-4444-555555555555"
        )
        monkeypatch.setenv(
            "WORKPILOT_ENTRA_CLIENT_ID", "66666666-7777-8888-9999-000000000000"
        )
        server_config.reset_settings_cache()
        today = await session_of(db, user_id, login)
        assert today["provider_name"] == "Microsoft Entra ID"
        assert today["issuer_host"] == "login.microsoftonline.com"
        # Another person's sign-in line is not the caller's.
        other = await session_of(db, world.users["admin_a"], login)
        assert other["signed_in_at"] is None


def test_an_issuer_without_a_usable_host_gives_none():
    from server.auth.sign_in import _host

    assert _host("https://idp.example.test/realms/x") == "idp.example.test"
    for bad in (None, 7, "not a url", "https://[bad"):
        assert _host(bad) is None
