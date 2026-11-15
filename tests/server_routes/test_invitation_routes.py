"""``/auth/invitations``: an organization administrator invites, the invitee
joins.

The invitation fixes the email, the organization and, when given, a project.
The link the administrator receives is the only place the token appears.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

from tests.server_routes.world import World

PASSWORD = "a-long-enough-secret-9"  # pragma: allowlist secret


def token_of(link: str) -> str:
    return parse_qs(urlparse(link).query)["token"][0]


async def invite(world: World, who: str = "admin_a", **body) -> dict:
    body.setdefault("email", "newcomer@example.com")
    answer = await world.call(who, "POST", "/auth/invitations", json=body)
    assert answer.status_code == 201, answer.text
    return answer.json()


async def accept(world: World, token: str, password: str = PASSWORD):
    return await world.client.post(
        "/auth/invitations/accept",
        json={"token": token, "display_name": "Newcomer", "password": password},
    )


async def age(world: World, invitation_id: str, **fields) -> None:
    """Rewrite stored fields of an invitation (expiry, revocation)."""
    from server.db.engine import get_session_factory
    from server.db.models import Invitation

    async with get_session_factory()() as db:
        row = await db.get(Invitation, invitation_id)
        for key, value in fields.items():
            setattr(row, key, value)
        await db.commit()


class TestIssuing:
    async def test_the_link_carries_a_token_the_list_never_shows(self, world):
        made = await invite(world)
        assert made["email"] == "newcomer@example.com"
        assert made["role"] == "member"
        assert made["email_sent"] is False
        assert made["invite_link"].startswith("/invite?token=")
        token = token_of(made["invite_link"])
        listed = await world.ok("admin_a", "GET", "/auth/invitations")
        assert [i["id"] for i in listed] == [made["id"]]
        assert token not in str(listed)
        audit = await world.ok("admin_a", "GET", "/admin/audit")
        assert "auth.invitation.created" in {row["action"] for row in audit}

    async def test_each_organization_lists_its_own(self, world):
        await invite(world)
        assert await world.ok("admin_b", "GET", "/auth/invitations") == []

    async def test_only_the_platform_invites_a_server_administrator(self, world):
        refused = await world.call(
            "admin_a",
            "POST",
            "/auth/invitations",
            json={"email": "root@example.com", "role": "admin"},
        )
        assert refused.status_code == 403
        assert refused.json()["detail"] == (
            "Only a platform admin can invite a server administrator"
        )
        assert await world.ok("admin_a", "GET", "/auth/invitations") == []

    async def test_the_platform_invites_an_administrator_into_an_org(self, world):
        answer = await world.call(
            "platform",
            "POST",
            "/auth/invitations",
            headers={"X-WorkPilot-Org": world.orgs["a"]},
            json={"email": "root@example.com", "role": "admin"},
        )
        assert answer.status_code == 201, answer.text
        assert answer.json()["role"] == "admin"

    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            (
                {"email": "contributor_a@example.com"},
                "A user with this email already exists",
            ),
            ({"role": "superuser"}, "Invalid role: superuser"),
            (
                {"project_role": "boss", "project_id": "<a>"},
                "Invalid project role: boss",
            ),
            ({"project_id": "<b>"}, "Unknown project"),
            ({"project_id": "no-such-project"}, "Unknown project"),
        ],
    )
    async def test_an_invitation_the_server_refuses(self, world, body, detail):
        body = {"email": "newcomer@example.com", **body}
        if body.get("project_id", "").startswith("<"):
            body["project_id"] = world.projects[body["project_id"][1]]
        answer = await world.call("admin_a", "POST", "/auth/invitations", json=body)
        assert answer.status_code == 400
        assert answer.json()["detail"] == detail
        assert await world.ok("admin_a", "GET", "/auth/invitations") == []

    async def test_revoking_takes_it_off_the_list_and_off_the_link(self, world):
        made = await invite(world)
        assert await world.ok(
            "admin_a", "DELETE", f"/auth/invitations/{made['id']}"
        ) == {"revoked": True}
        assert await world.ok("admin_a", "GET", "/auth/invitations") == []
        looked = await world.client.post(
            "/auth/invitations/lookup", json={"token": token_of(made["invite_link"])}
        )
        assert looked.status_code == 404
        assert looked.json()["detail"] == "Invitation was revoked"
        audit = await world.ok("admin_a", "GET", "/admin/audit")
        assert "auth.invitation.revoked" in {row["action"] for row in audit}

    async def test_another_organization_cannot_revoke_it(self, world):
        made = await invite(world)
        answer = await world.call(
            "admin_b", "DELETE", f"/auth/invitations/{made['id']}"
        )
        assert answer.status_code == 404
        assert answer.json()["detail"] == "No revocable invitation found"
        assert len(await world.ok("admin_a", "GET", "/auth/invitations")) == 1

    async def test_an_accepted_invitation_is_no_longer_revocable(self, world):
        made = await invite(world)
        assert (await accept(world, token_of(made["invite_link"]))).status_code == 200
        answer = await world.call(
            "admin_a", "DELETE", f"/auth/invitations/{made['id']}"
        )
        assert answer.status_code == 404


class TestJoining:
    async def test_the_invitee_sees_who_is_invited_then_joins_signed_in(self, world):
        made = await invite(world)
        token = token_of(made["invite_link"])
        looked = await world.client.post(
            "/auth/invitations/lookup", json={"token": token}
        )
        assert looked.json() == {"email": "newcomer@example.com", "role": "member"}

        joined = await accept(world, token)
        assert joined.status_code == 200, joined.text
        body = joined.json()
        assert body["user"]["email"] == "newcomer@example.com"
        assert body["user"]["display_name"] == "Newcomer"
        me = await world.client.get(
            "/auth/me/permissions",
            headers={"Authorization": f"Bearer {body['access_token']}"},
        )
        assert me.json()["org_id"] == world.orgs["a"]
        assert me.json()["org_role"] == "contributor"
        # Off every project until someone adds them.
        listed = await world.client.get(
            "/projects", headers={"Authorization": f"Bearer {body['access_token']}"}
        )
        assert listed.json() == []
        # The invitation is spent.
        assert await world.ok("admin_a", "GET", "/auth/invitations") == []
        again = await accept(world, token)
        assert again.status_code == 404
        assert again.json()["detail"] == "Invitation has already been used"
        login = await world.client.post(
            "/auth/login", json={"email": "newcomer@example.com", "password": PASSWORD}
        )
        assert login.status_code == 200

    async def test_an_invitation_to_a_project_brings_the_project(self, world):
        a = world.projects["a"]
        made = await invite(world, project_id=a, project_role="viewer")
        joined = (await accept(world, token_of(made["invite_link"]))).json()
        listed = await world.client.get(
            "/projects", headers={"Authorization": f"Bearer {joined['access_token']}"}
        )
        assert [(p["id"], p["my_role"]) for p in listed.json()] == [(a, "viewer")]

    async def test_an_expired_invitation_neither_shows_nor_opens(self, world):
        made = await invite(world)
        await age(
            world, made["id"], expires_at=datetime.now(UTC) - timedelta(minutes=1)
        )
        token = token_of(made["invite_link"])
        looked = await world.client.post(
            "/auth/invitations/lookup", json={"token": token}
        )
        assert looked.status_code == 404
        assert looked.json()["detail"] == "Invitation has expired"
        assert (await accept(world, token)).status_code == 404
        # Still listed, so the administrator can see it lapsed and revoke it.
        assert len(await world.ok("admin_a", "GET", "/auth/invitations")) == 1

    async def test_an_unknown_token_is_not_found(self, world):
        looked = await world.client.post(
            "/auth/invitations/lookup", json={"token": "x" * 43}
        )
        assert looked.status_code == 404
        assert looked.json()["detail"] == "Invitation not found"

    async def test_a_weak_password_creates_no_account(self, world):
        made = await invite(world)
        token = token_of(made["invite_link"])
        weak = await accept(world, token, password="newcomer@example.com")
        assert weak.status_code == 400
        # The invitation still holds for a proper password.
        assert (await accept(world, token)).status_code == 200

    async def test_an_account_made_since_the_invitation_wins(self, world):
        made = await invite(world)
        created = await world.call(
            "platform",
            "POST",
            "/auth/users",
            json={
                "email": "newcomer@example.com",
                "password": PASSWORD,
                "display_name": "Already here",
            },
        )
        assert created.status_code == 201, created.text
        answer = await accept(world, token_of(made["invite_link"]))
        assert answer.status_code == 400

    async def test_an_invitation_whose_role_is_gone_places_no_one(self, world):
        made = await invite(world)
        await age(world, made["id"], org_role_id=None)
        answer = await accept(world, token_of(made["invite_link"]))
        assert answer.status_code == 404
        assert answer.json()["detail"] == (
            "Invitation is no longer valid; ask for a new one"
        )
