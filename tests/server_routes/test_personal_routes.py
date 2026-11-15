"""``/users``: the directory, and a person's own settings.

These routes name no user: each person reads and writes only their own
secrets, phones, theme, access tokens and "needs you" channels, whoever else
is signed in on the same server.
"""

from __future__ import annotations

import pytest

from tests.server_routes.world import World

#: Obviously fake values, shaped as the routes expect them.
FAKE_PAT = "fake-forge-token-for-route-tests"  # pragma: allowlist secret
PHONE = "ExponentPushToken[route-tests-phone-1]"
TOPIC = "route-tests-topic-long-enough"


@pytest.fixture
def vault(monkeypatch):
    """A secrets master key, as an operator sets one."""
    from cryptography.fernet import Fernet
    from server import config as server_config

    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    server_config.reset_settings_cache()


class TestTheDirectory:
    async def test_a_person_sees_the_active_people_of_their_organization(self, world):
        names = [u["display_name"] for u in await world.ok("viewer_a", "GET", "/users")]
        assert names == sorted(names)
        assert "owner_a" in names and "stranger_a" in names
        assert "admin_b" not in names and "platform" not in names
        await world.ok(
            "admin_a", "POST", f"/admin/users/{world.users['stranger_a']}/deactivate"
        )
        names = [u["display_name"] for u in await world.ok("viewer_a", "GET", "/users")]
        assert "stranger_a" not in names

    async def test_the_platform_administrator_sees_every_account(self, world):
        names = {u["display_name"] for u in await world.ok("platform", "GET", "/users")}
        assert names == set(world.users)


class TestSecrets:
    async def test_each_person_keeps_their_own_and_the_value_never_comes_back(
        self, world, vault
    ):
        saved = await world.ok(
            "contributor_a",
            "PUT",
            "/users/me/secrets",
            json={"kind": "github_token", "value": f"  {FAKE_PAT}  "},
        )
        assert saved == {"saved": True}
        mine = await world.call("contributor_a", "GET", "/users/me/secrets")
        assert mine.json() == {"kinds": ["github_token"]}
        assert FAKE_PAT not in mine.text
        assert await world.ok("viewer_a", "GET", "/users/me/secrets") == {"kinds": []}
        assert await world.ok(
            "viewer_a", "DELETE", "/users/me/secrets/github_token"
        ) == {"deleted": False}
        assert await world.ok(
            "contributor_a", "DELETE", "/users/me/secrets/github_token"
        ) == {"deleted": True}
        assert await world.ok("contributor_a", "GET", "/users/me/secrets") == {
            "kinds": []
        }

    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            ({"kind": "aws_root_key", "value": FAKE_PAT}, "Unknown secret kind"),
            ({"kind": "github_token", "value": "   "}, "Invalid secret value"),
            ({"kind": "github_token", "value": "x" * 4097}, "Invalid secret value"),
        ],
    )
    async def test_a_secret_the_server_will_not_keep(self, world, vault, body, detail):
        answer = await world.call(
            "contributor_a", "PUT", "/users/me/secrets", json=body
        )
        assert answer.status_code == 400
        assert answer.json()["detail"].startswith(detail)
        assert await world.ok("contributor_a", "GET", "/users/me/secrets") == {
            "kinds": []
        }

    async def test_without_a_master_key_nothing_is_stored(self, world):
        answer = await world.call(
            "contributor_a",
            "PUT",
            "/users/me/secrets",
            json={"kind": "github_token", "value": FAKE_PAT},
        )
        assert answer.status_code == 500
        assert "WORKPILOT_SECRETS_MASTER_KEY is not set" in answer.json()["detail"]
        assert FAKE_PAT not in answer.text


class TestDevices:
    async def test_a_phone_belongs_to_the_last_person_who_signed_in_on_it(self, world):
        body = {"token": PHONE, "platform": "ios", "locale": "fr"}
        assert await world.ok(
            "contributor_a", "PUT", "/users/me/devices", json=body
        ) == {"registered": True}
        assert await world.ok("viewer_a", "PUT", "/users/me/devices", json=body) == {
            "registered": True
        }
        # Moved: the first person no longer holds it, the second does.
        gone = await world.ok(
            "contributor_a", "DELETE", "/users/me/devices", json={"token": PHONE}
        )
        assert gone == {"removed": False}
        assert await world.ok(
            "viewer_a", "DELETE", "/users/me/devices", json={"token": PHONE}
        ) == {"removed": True}

    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            ({"token": "not-a-push-token", "platform": "ios"}, "Invalid push token"),
            ({"token": PHONE, "platform": "symbian"}, "Unknown platform"),
        ],
    )
    async def test_a_registration_the_server_refuses(self, world, body, detail):
        answer = await world.call(
            "contributor_a", "PUT", "/users/me/devices", json=body
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == detail


class TestPreferences:
    async def test_the_theme_follows_the_person_not_the_server(self, world):
        empty = {"theme": None, "colorTheme": None}
        assert await world.ok("contributor_a", "GET", "/users/me/preferences") == empty
        chosen = {"theme": "dark", "colorTheme": "ocean"}
        assert (
            await world.ok("contributor_a", "PUT", "/users/me/preferences", json=chosen)
            == chosen
        )
        assert await world.ok("contributor_a", "GET", "/users/me/preferences") == chosen
        assert await world.ok("viewer_a", "GET", "/users/me/preferences") == empty

    @pytest.mark.parametrize(
        "body",
        [
            {"theme": "neon", "colorTheme": "ocean"},
            {"theme": "dark", "colorTheme": "ocean", "fontSize": 30},
            {"theme": "dark"},
        ],
    )
    async def test_anything_outside_the_lists_is_refused(self, world, body):
        answer = await world.call(
            "contributor_a", "PUT", "/users/me/preferences", json=body
        )
        assert answer.status_code == 422
        assert (await world.ok("contributor_a", "GET", "/users/me/preferences"))[
            "theme"
        ] is None


async def make_token(
    world: World, who: str, headers: dict[str, str] | None = None, **body
) -> dict:
    body.setdefault("name", "Claude Desktop")
    answer = await world.call(
        who, "POST", "/users/me/access-tokens", headers=headers, json=body
    )
    assert answer.status_code == 201, answer.text
    return answer.json()


async def mcp(world: World, raw: str, path: str = "/mcp"):
    return await world.client.post(
        path,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {raw}"},
    )


class TestAccessTokens:
    async def test_a_token_is_shown_once_and_opens_only_the_mcp_endpoint(self, world):
        made = await make_token(world, "contributor_a", scope="write")
        raw = made["token"]
        assert raw.startswith("wpat_") and raw.startswith(made["prefix"])
        assert made["org_id"] == world.orgs["a"]
        listed = await world.call("contributor_a", "GET", "/users/me/access-tokens")
        assert [t["id"] for t in listed.json()] == [made["id"]]
        assert raw not in listed.text

        assert (await mcp(world, raw)).status_code == 200
        elsewhere = await world.client.get(
            "/projects", headers={"Authorization": f"Bearer {raw}"}
        )
        assert elsewhere.status_code == 401
        audit = await world.ok("admin_a", "GET", "/admin/audit")
        assert "access_token.create" in {row["action"] for row in audit}

    async def test_a_token_is_made_for_the_organization_acted_in(self, world):
        made = await make_token(
            world, "platform", headers={"X-WorkPilot-Org": world.orgs["b"]}
        )
        assert made["org_id"] == world.orgs["b"]
        answer = await world.call(
            "platform", "POST", "/users/me/access-tokens", json={"name": "No org"}
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == "Pick an organization first"

    async def test_a_role_that_reads_nothing_gets_no_token(self, world):
        answer = await world.call(
            "nobody_a", "POST", "/users/me/access-tokens", json={"name": "Key"}
        )
        assert answer.status_code == 403
        assert answer.json()["detail"] == "Missing permission: task.read"

    async def test_only_its_owner_lists_or_revokes_it(self, world):
        made = await make_token(world, "contributor_a")
        assert await world.ok("viewer_a", "GET", "/users/me/access-tokens") == []
        other = await world.call(
            "viewer_a", "DELETE", f"/users/me/access-tokens/{made['id']}"
        )
        assert other.status_code == 404
        assert (await mcp(world, made["token"])).status_code == 200

        assert await world.ok(
            "contributor_a", "DELETE", f"/users/me/access-tokens/{made['id']}"
        ) == {"revoked": True}
        assert await world.ok("contributor_a", "GET", "/users/me/access-tokens") == []
        revoked = await mcp(world, made["token"])
        assert revoked.status_code == 401
        assert revoked.json()["detail"] == "Invalid, revoked or expired token"

    async def test_leaving_the_organization_closes_the_token(self, world):
        made = await make_token(world, "stranger_a")
        assert (await mcp(world, made["token"])).status_code == 200
        await world.ok(
            "admin_a", "DELETE", f"/admin/members/{world.users['stranger_a']}"
        )
        assert (await mcp(world, made["token"])).status_code == 401

    async def test_a_deactivated_owner_closes_the_token(self, world):
        made = await make_token(world, "stranger_a")
        await world.ok(
            "admin_a", "POST", f"/admin/users/{world.users['stranger_a']}/deactivate"
        )
        assert (await mcp(world, made["token"])).status_code == 401

    async def test_a_lifetime_out_of_range_is_refused(self, world):
        answer = await world.call(
            "contributor_a",
            "POST",
            "/users/me/access-tokens",
            json={"name": "Forever", "ttl_days": 100000},
        )
        assert answer.status_code == 422


class TestNeedsYou:
    async def test_the_overview_starts_with_every_moment_on_and_no_channel(self, world):
        seen = await world.ok("contributor_a", "GET", "/users/me/needs-you")
        assert seen["available"] is False
        assert seen["vault"] is False
        assert set(seen["events"].values()) == {True}
        assert {c["configured"] for c in seen["channels"].values()} == {False}

    async def test_muting_a_moment_is_the_person_s_own(self, world):
        await world.ok(
            "contributor_a",
            "PUT",
            "/users/me/needs-you/preferences",
            json={"events": {"failed": False}, "locale": "fr"},
        )
        mine = await world.ok("contributor_a", "GET", "/users/me/needs-you")
        assert mine["events"]["failed"] is False and mine["locale"] == "fr"
        theirs = await world.ok("viewer_a", "GET", "/users/me/needs-you")
        assert theirs["events"]["failed"] is True and theirs["locale"] == "en"
        unknown = await world.call(
            "contributor_a",
            "PUT",
            "/users/me/needs-you/preferences",
            json={"events": {"birthday": True}},
        )
        assert unknown.status_code == 400
        assert unknown.json()["detail"] == "Unknown moment"

    async def test_a_channel_needs_the_vault(self, world):
        answer = await world.call(
            "contributor_a",
            "PUT",
            "/users/me/needs-you/channels/ntfy",
            json={"topic": TOPIC},
        )
        assert answer.status_code == 409

    async def test_a_channel_is_stored_masked_and_for_its_owner_only(
        self, world, vault
    ):
        assert await world.ok(
            "contributor_a",
            "PUT",
            "/users/me/needs-you/channels/ntfy",
            json={"topic": TOPIC},
        ) == {"saved": True}
        answer = await world.call("contributor_a", "GET", "/users/me/needs-you")
        ntfy = answer.json()["channels"]["ntfy"]
        assert ntfy["configured"] is True and ntfy["readable"] is True
        assert ntfy["topic"] == "********"
        assert TOPIC not in answer.text
        theirs = await world.ok("viewer_a", "GET", "/users/me/needs-you")
        assert theirs["channels"]["ntfy"] == {"configured": False}
        assert await world.ok(
            "viewer_a", "DELETE", "/users/me/needs-you/channels/ntfy"
        ) == {"deleted": False}
        assert await world.ok(
            "contributor_a", "DELETE", "/users/me/needs-you/channels/ntfy"
        ) == {"deleted": True}

    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            ({"topic": "short"}, "On ntfy.sh, a topic needs at least 16 characters"),
            (
                {"topic": TOPIC, "server": "http://ntfy.example.com"},
                "Only https URLs are allowed",
            ),
            (
                {"topic": TOPIC, "server": "https://10.0.0.1"},
                "Use a host name, not an IP address",
            ),
        ],
    )
    async def test_a_destination_the_server_refuses(self, world, vault, body, detail):
        answer = await world.call(
            "contributor_a", "PUT", "/users/me/needs-you/channels/ntfy", json=body
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == detail

    async def test_an_unknown_channel_is_not_found(self, world):
        answer = await world.call(
            "contributor_a", "DELETE", "/users/me/needs-you/channels/pigeon"
        )
        assert answer.status_code == 404
        assert answer.json()["detail"] == "Unknown channel"

    async def test_no_test_message_leaves_a_server_where_it_is_off(self, world):
        answer = await world.call(
            "contributor_a", "POST", "/users/me/needs-you/channels/ntfy/test"
        )
        assert answer.status_code == 409
        assert answer.json()["detail"] == "Turned off on this server"

    async def test_a_test_needs_a_channel_set(self, world, monkeypatch):
        from server import config as server_config

        monkeypatch.setenv("WORKPILOT_NEEDS_YOU_ENABLED", "1")
        server_config.reset_settings_cache()
        answer = await world.call(
            "contributor_a", "POST", "/users/me/needs-you/channels/ntfy/test"
        )
        assert answer.status_code == 404
        assert answer.json()["detail"] == "Channel not set"
