"""``/auth/password-reset`` and ``POST /admin/users/{id}/password-reset``.

A person who lost their password asks for a link by email; a platform admin
issues one for an account. The link sets a new password once, closes the
other links and signs the account out everywhere. ``request`` answers the
same whether or not the address has an account.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

from tests.server_routes.world import World

NEW_PASSWORD = "a-brand-new-passphrase-42"  # pragma: allowlist secret


def token_of(link: str) -> str:
    return parse_qs(urlparse(link).query)["token"][0]


@pytest.fixture()
def mailbox(monkeypatch):
    """SMTP configured, and the emails the server would send."""
    from server import config as server_config
    from server.routers import password_reset as reset_routes
    from server.routers.admin import users as admin_users

    monkeypatch.setenv("WORKPILOT_SMTP_HOST", "smtp.example.test")
    monkeypatch.setenv("WORKPILOT_SMTP_FROM", "WorkPilot <noreply@example.test>")
    server_config.reset_settings_cache()
    sent: list[dict] = []

    async def fake_send(to_email: str, link: str, minutes: int) -> None:
        sent.append({"to": to_email, "link": link, "minutes": minutes})

    monkeypatch.setattr(reset_routes, "send_password_reset_email", fake_send)
    monkeypatch.setattr(admin_users, "send_password_reset_email", fake_send)
    yield sent
    server_config.reset_settings_cache()


async def ask(world: World, email: str):
    return await world.client.post(
        "/auth/password-reset/request", json={"email": email}
    )


async def confirm(world: World, token: str, password: str = NEW_PASSWORD):
    return await world.client.post(
        "/auth/password-reset/confirm",
        json={"token": token, "new_password": password},
    )


async def login(world: World, who: str, password: str):
    return await world.client.post(
        "/auth/login", json={"email": f"{who}@example.com", "password": password}
    )


async def rows(world: World, who: str) -> list:
    from server.db.engine import get_session_factory
    from server.db.models import PasswordReset
    from sqlalchemy import select

    async with get_session_factory()() as db:
        return list(
            await db.scalars(
                select(PasswordReset).where(PasswordReset.user_id == world.users[who])
            )
        )


async def actions(world: World) -> set[str]:
    from server.db.engine import get_session_factory
    from server.db.models import AuditLog
    from sqlalchemy import select

    async with get_session_factory()() as db:
        return set(await db.scalars(select(AuditLog.action)))


class TestAsking:
    async def test_the_config_says_whether_an_email_can_go(self, world, mailbox):
        answer = await world.call(None, "GET", "/auth/config")
        assert answer.json()["password_reset_by_email"] is True

    async def test_a_local_account_gets_a_link_by_email(self, world, mailbox):
        await world.give_password("contributor_a")
        answer = await ask(world, "Contributor_A@example.com")
        assert answer.status_code == 202
        assert answer.json() == {"requested": True}
        assert [m["to"] for m in mailbox] == ["contributor_a@example.com"]
        assert mailbox[0]["link"].startswith("/reset-password?token=")
        assert mailbox[0]["minutes"] == 60
        # Only the token's hash is kept.
        (row,) = await rows(world, "contributor_a")
        assert token_of(mailbox[0]["link"]) not in row.token_hash
        assert "auth.password_reset.requested" in await actions(world)

    async def test_the_link_uses_the_public_address(self, world, mailbox, monkeypatch):
        from server import config as server_config

        monkeypatch.setenv("WORKPILOT_PUBLIC_BASE_URL", "https://wp.example.test")
        server_config.reset_settings_cache()
        await world.give_password("contributor_a")
        await ask(world, "contributor_a@example.com")
        assert mailbox[0]["link"].startswith(
            "https://wp.example.test/reset-password?token="
        )

    @pytest.mark.parametrize("case", ["unknown", "no_password", "disabled"])
    async def test_the_answer_is_the_same_when_nothing_is_sent(
        self, world, mailbox, case
    ):
        email = "contributor_a@example.com"
        if case == "unknown":
            email = "nobody-here@example.com"
        elif case == "disabled":
            await world.give_password("contributor_a")
            await _set_active(world, "contributor_a", False)
        answer = await ask(world, email)
        assert answer.status_code == 202
        assert answer.json() == {"requested": True}
        assert mailbox == []

    async def test_a_second_ask_at_once_sends_nothing_more(self, world, mailbox):
        await world.give_password("contributor_a")
        await ask(world, "contributor_a@example.com")
        await ask(world, "contributor_a@example.com")
        assert len(mailbox) == 1

    async def test_without_smtp_nothing_is_kept_nor_sent(self, world):
        await world.give_password("contributor_a")
        answer = await ask(world, "contributor_a@example.com")
        assert answer.status_code == 202
        assert answer.json() == {"requested": True}
        assert await rows(world, "contributor_a") == []

    async def test_asking_is_rate_limited(self, world, mailbox):
        codes = [(await ask(world, f"n{i}@example.com")).status_code for i in range(6)]
        assert codes[:5] == [202] * 5
        assert codes[5] == 429


class TestSetting:
    async def test_the_link_sets_the_password_once_and_signs_out(self, world, mailbox):
        old = await world.give_password("contributor_a")
        signed = await login(world, "contributor_a", old)
        assert signed.status_code == 200
        refresh = signed.json()["refresh_token"]
        await ask(world, "contributor_a@example.com")
        token = token_of(mailbox[0]["link"])

        looked = await world.client.post(
            "/auth/password-reset/lookup", json={"token": token}
        )
        assert looked.json() == {"email": "contributor_a@example.com"}

        done = await confirm(world, token)
        assert done.status_code == 200, done.text
        assert done.json() == {"reset": True}
        assert (await login(world, "contributor_a", old)).status_code == 401
        assert (await login(world, "contributor_a", NEW_PASSWORD)).status_code == 200
        # The session opened before the reset is gone.
        again = await world.client.post(
            "/auth/refresh", json={"refresh_token": refresh}
        )
        assert again.status_code == 401
        # The link served once.
        assert (await confirm(world, token)).status_code == 404
        assert (
            await world.client.post(
                "/auth/password-reset/lookup", json={"token": token}
            )
        ).status_code == 404
        assert "auth.password_reset.completed" in await actions(world)

    async def test_a_refused_password_leaves_the_link_usable(self, world, mailbox):
        await world.give_password("contributor_a")
        await ask(world, "contributor_a@example.com")
        token = token_of(mailbox[0]["link"])
        weak = await confirm(world, token, password="contributor_a@example.com")
        assert weak.status_code in {400, 422}
        assert (await confirm(world, token)).status_code == 200

    async def test_an_expired_link_is_refused(self, world, mailbox):
        await world.give_password("contributor_a")
        await ask(world, "contributor_a@example.com")
        token = token_of(mailbox[0]["link"])
        await _expire(world, "contributor_a")
        answer = await confirm(world, token)
        assert answer.status_code == 404
        assert answer.json()["detail"] == "This reset link is invalid or has expired"

    async def test_an_unknown_token_is_refused(self, world):
        assert (await confirm(world, "x" * 43)).status_code == 404

    async def test_a_newer_link_closes_the_older(self, world):
        await world.give_password("contributor_a")
        first = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        second = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        assert (await confirm(world, token_of(first["reset_link"]))).status_code == 404
        assert (await confirm(world, token_of(second["reset_link"]))).status_code == 200

    async def test_a_disabled_account_cannot_use_its_link(self, world):
        await world.give_password("contributor_a")
        issued = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        token = token_of(issued["reset_link"])
        await _set_active(world, "contributor_a", False)
        assert (await confirm(world, token)).status_code == 404
        looked = await world.client.post(
            "/auth/password-reset/lookup", json={"token": token}
        )
        assert looked.status_code == 404

    async def test_an_account_whose_password_was_removed(self, world):
        await world.give_password("contributor_a")
        issued = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        await _drop_local_identity(world, "contributor_a")
        assert (await confirm(world, token_of(issued["reset_link"]))).status_code == 404

    async def test_an_email_that_fails_still_answers_the_same(
        self, world, mailbox, monkeypatch
    ):
        from server.routers import password_reset as reset_routes
        from server.services.email import EmailError

        async def broken(*_args) -> None:
            raise EmailError("refused")

        monkeypatch.setattr(reset_routes, "send_password_reset_email", broken)
        await world.give_password("contributor_a")
        answer = await ask(world, "contributor_a@example.com")
        assert answer.status_code == 202
        assert answer.json() == {"requested": True}


class TestAdmin:
    async def test_without_smtp_the_admin_gets_the_link(self, world):
        await world.give_password("contributor_a")
        issued = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        assert issued["email"] == "contributor_a@example.com"
        assert issued["email_sent"] is False
        assert issued["reset_link"].startswith("/reset-password?token=")
        assert "auth.password_reset.issued" in await actions(world)

    async def test_with_smtp_the_link_goes_by_email_only(self, world, mailbox):
        await world.give_password("contributor_a")
        issued = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        assert issued["email_sent"] is True
        assert issued["reset_link"] is None
        assert [m["to"] for m in mailbox] == ["contributor_a@example.com"]

    async def test_an_organization_admin_cannot(self, world):
        await world.give_password("contributor_a")
        answer = await world.call(
            "admin_a",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        assert answer.status_code == 403
        assert await rows(world, "contributor_a") == []

    async def test_an_account_without_a_local_password(self, world):
        answer = await world.call(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == "This account has no local password"
        assert "auth.password_reset.issued" not in await actions(world)

    async def test_a_disabled_account(self, world):
        await world.give_password("contributor_a")
        await _set_active(world, "contributor_a", False)
        answer = await world.call(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        assert answer.status_code == 400
        assert answer.json()["detail"] == "This account is disabled"

    async def test_an_email_that_fails_hands_the_link_over(
        self, world, mailbox, monkeypatch
    ):
        from server.routers.admin import users as admin_users
        from server.services.email import EmailError

        async def broken(*_args) -> None:
            raise EmailError("refused")

        monkeypatch.setattr(admin_users, "send_password_reset_email", broken)
        await world.give_password("contributor_a")
        issued = await world.ok(
            "platform",
            "POST",
            f"/admin/users/{world.users['contributor_a']}/password-reset",
        )
        assert issued["email_sent"] is False
        assert issued["reset_link"].startswith("/reset-password?token=")

    async def test_an_unknown_account(self, world):
        answer = await world.call(
            "platform", "POST", "/admin/users/no-such-user/password-reset"
        )
        assert answer.status_code == 404


async def _set_active(world: World, who: str, active: bool) -> None:
    from server.db.engine import get_session_factory
    from server.db.models import User

    async with get_session_factory()() as db:
        user = await db.get(User, world.users[who])
        user.is_active = active
        await db.commit()


async def _expire(world: World, who: str) -> None:
    from server.db.engine import get_session_factory
    from server.db.models import PasswordReset
    from sqlalchemy import update

    async with get_session_factory()() as db:
        await db.execute(
            update(PasswordReset)
            .where(PasswordReset.user_id == world.users[who])
            .values(expires_at=datetime.now(UTC) - timedelta(minutes=1))
        )
        await db.commit()


async def _drop_local_identity(world: World, who: str) -> None:
    from server.db.engine import get_session_factory
    from server.db.models import UserIdentity
    from sqlalchemy import delete

    async with get_session_factory()() as db:
        await db.execute(
            delete(UserIdentity).where(UserIdentity.user_id == world.users[who])
        )
        await db.commit()
