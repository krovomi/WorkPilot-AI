"""'Needs you' from the server (``server.services.needs_you`` and its routes).

What is checked: each destination is validated when it is saved (https only,
no credentials, port 443, no address, Teams only on Microsoft's hosts, the
desktop's ntfy and Telegram rules) and again when it is sent (every resolved
address public, the request pinned to it, no redirect); the three formats
match the desktop's; secrets are stored encrypted, never returned (a mask),
kept when the mask comes back, refused without a master key, and never
logged; a run's end maps to the right moment; sending is off by default,
runs in the background, honours muted moments and never fails a run; each
route carries its permission and touches only its caller's rows.
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from pathlib import Path

import httpx
import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

# Obvious fakes, in the shape the validators accept.
_BOT = "123:" + "x" * 24
_TOPIC = "wp-topic-0000000000000000"
_TEAMS = "https://contoso.webhook.office.com/webhookb2/fake-0000"
_NTFY_TOKEN = "tk_fake0000"


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    from cryptography.fernet import Fernet

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", "x" * 48)
    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "ny.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.services import needs_you

    needs_you._last_test.clear()
    yield
    needs_you.set_approval_check(None)
    server_config.reset_settings_cache()


def _enable(monkeypatch):
    monkeypatch.setenv("WORKPILOT_NEEDS_YOU_ENABLED", "1")
    server_config.reset_settings_cache()


async def _fresh_db():
    from server.db import engine as db_engine

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    return db_engine.get_session_factory()()


async def _user(db, email: str):
    from server.auth.local import create_local_user

    return await create_local_user(
        db, email=email, password="correct-horse-battery-staple", display_name="P"
    )


def _resolver(*addresses: str):
    async def resolve(host: str) -> list[str]:
        return list(addresses)

    return resolve


_PUBLIC = _resolver("93.184.216.34")


class TestValidation:
    def test_ntfy_defaults_to_the_public_server(self):
        from server.services.needs_you_send import validate_ntfy

        assert validate_ntfy(None, _TOPIC) == "https://ntfy.sh"
        assert validate_ntfy("https://ntfy.example.com/", "short") == (
            "https://ntfy.example.com"
        )

    @pytest.mark.parametrize(
        ("server", "topic", "reason"),
        [
            ("https://ntfy.sh", "short-topic", "short_topic"),
            ("http://ntfy.example.com", _TOPIC, "scheme"),
            ("https://user:pw@ntfy.example.com", _TOPIC, "credentials"),
            ("https://ntfy.example.com:8443", _TOPIC, "port"),
            ("https://127.0.0.1", _TOPIC, "address"),
            ("https://[::1]", _TOPIC, "address"),
            ("https://169.254.169.254", _TOPIC, "address"),
            ("https://localhost", _TOPIC, "private"),
            ("file:///etc/passwd", _TOPIC, "scheme"),
            ("https://ntfy.example.com", "a/b", "topic"),
            ("https://ntfy.example.com", "", "topic"),
            ("https://ntfy.example.com/?x=1", _TOPIC, "url"),
        ],
    )
    def test_ntfy_refusals(self, server, topic, reason):
        from server.services.needs_you_send import ChannelRejected, validate_ntfy

        with pytest.raises(ChannelRejected) as e:
            validate_ntfy(server, topic)
        assert e.value.reason == reason

    def test_telegram(self):
        from server.services.needs_you_send import ChannelRejected, validate_telegram

        assert validate_telegram(_BOT, " -100123 ") == "-100123"
        with pytest.raises(ChannelRejected):
            validate_telegram("not-a-token", "1")
        with pytest.raises(ChannelRejected):
            validate_telegram(_BOT, "@channel")

    @pytest.mark.parametrize(
        "url",
        [
            "https://contoso.webhook.office.com/webhookb2/x",
            "https://prod-01.westeurope.logic.azure.com/workflows/x",
            "https://abc.environment.api.powerplatform.com/x",
        ],
    )
    def test_teams_on_microsoft_hosts(self, url):
        from server.services.needs_you_send import validate_teams

        assert validate_teams(url) == url

    @pytest.mark.parametrize(
        "url",
        [
            "https://evil.example.com/webhook",
            "https://webhook.office.com.evil.example/x",
            "http://contoso.webhook.office.com/x",
            "https://contoso.webhook.office.com:444/x",
            "",
            None,
        ],
    )
    def test_teams_elsewhere_is_refused(self, url):
        from server.services.needs_you_send import ChannelRejected, validate_teams

        with pytest.raises(ChannelRejected):
            validate_teams(url)


class TestPinnedPost:
    @pytest.mark.parametrize(
        "address",
        [
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1%eth0",
            "::ffff:127.0.0.1",
            "224.0.0.1",
        ],
    )
    def test_non_public_addresses_are_not_public(self, address):
        from server.services.needs_you_send import _public

        assert not _public(address)

    def test_a_public_address_is(self):
        from server.services.needs_you_send import _public

        assert _public("93.184.216.34")
        assert _public("2606:2800:220:1:248:1893:25c8:1946")

    @pytest.mark.asyncio
    async def test_the_request_goes_to_the_checked_address(self):
        from server.services.needs_you_send import post

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            await post(c, "https://ntfy.example.com/t?a=1", resolver=_PUBLIC, json={})
        (request,) = seen
        assert request.url.host == "93.184.216.34"
        assert request.url.path == "/t" and request.url.query == b"a=1"
        assert request.headers["host"] == "ntfy.example.com"
        assert request.extensions["sni_hostname"] == "ntfy.example.com"

    @pytest.mark.asyncio
    async def test_ipv6_is_bracketed(self):
        from server.services.needs_you_send import post

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            await post(
                c,
                "https://ntfy.example.com/t",
                resolver=_resolver("2606:2800:220:1:248:1893:25c8:1946"),
            )
        assert seen[0].url.host == "2606:2800:220:1:248:1893:25c8:1946"

    @pytest.mark.asyncio
    async def test_one_private_address_among_public_ones_blocks(self):
        from server.services.needs_you_send import ChannelRejected, post

        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("no request expected")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            with pytest.raises(ChannelRejected) as e:
                await post(
                    c,
                    "https://rebind.example.com/",
                    resolver=_resolver("93.184.216.34", "169.254.169.254"),
                )
        assert e.value.reason == "private"

    @pytest.mark.asyncio
    async def test_a_redirect_is_not_followed(self):
        from server.services.needs_you_send import Message, deliver

        calls: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request)
            return httpx.Response(
                302, headers={"Location": "http://169.254.169.254/latest/meta-data"}
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            result = await deliver(
                "teams",
                {},
                {"webhook_url": _TEAMS},
                Message("t", "b"),
                client=c,
                resolver=_PUBLIC,
            )
        assert result == "refused"
        assert len(calls) == 1


class TestFormats:
    @pytest.mark.asyncio
    async def test_ntfy_like_the_desktop(self):
        from server.services.needs_you_send import Message, deliver

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            result = await deliver(
                "ntfy",
                {"server": "https://ntfy.example.com"},
                {"topic": _TOPIC, "access_token": _NTFY_TOKEN},
                Message("Un plan t'attend", "Payments, carte 012"),
                client=c,
                resolver=_PUBLIC,
            )
        assert result == "sent"
        (request,) = seen
        assert request.url.path == f"/{_TOPIC}"
        assert request.url.params["title"] == "Un plan t'attend"
        assert request.url.params["tags"] == "robot"
        assert request.headers["authorization"] == f"Bearer {_NTFY_TOKEN}"
        assert request.content.decode("utf-8") == "Payments, carte 012"

    @pytest.mark.asyncio
    async def test_telegram_plain_text(self):
        from server.services.needs_you_send import Message, deliver

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"ok": True})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            result = await deliver(
                "telegram",
                {"chat_id": "42"},
                {"bot_token": _BOT},
                Message("Ready for review", "<b>P</b>, card 3"),
                client=c,
                resolver=_PUBLIC,
            )
        assert result == "sent"
        assert seen[0].url.path == f"/bot{_BOT}/sendMessage"
        assert seen[0].headers["host"] == "api.telegram.org"
        body = json.loads(seen[0].content)
        assert body["chat_id"] == "42"
        assert body["text"] == "Ready for review\n<b>P</b>, card 3"
        assert "parse_mode" not in body

    @pytest.mark.asyncio
    async def test_telegram_not_ok_is_refused(self):
        from server.services.needs_you_send import Message, deliver

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": False})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            result = await deliver(
                "telegram",
                {"chat_id": "42"},
                {"bot_token": _BOT},
                Message("t", "b"),
                client=c,
                resolver=_PUBLIC,
            )
        assert result == "refused"

    def test_teams_adaptive_card(self):
        from server.services.needs_you_send import Message, teams_card

        card = teams_card(Message("Title", "Body"))
        content = card["attachments"][0]["content"]
        assert content["type"] == "AdaptiveCard"
        assert [b["text"] for b in content["body"]] == ["Title", "Body"]


class TestNoSecretInLogs:
    @pytest.mark.asyncio
    async def test_a_network_failure_logs_the_type_only(self, caplog):
        from server.services.needs_you_send import Message, deliver

        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError(f"cannot reach {request.url}")

        caplog.set_level(logging.DEBUG)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            result = await deliver(
                "telegram",
                {"chat_id": "42"},
                {"bot_token": _BOT},
                Message("t", "b"),
                client=c,
                resolver=_PUBLIC,
            )
        assert result == "unreachable"
        assert _BOT not in caplog.text
        assert "ConnectError" in caplog.text

    @pytest.mark.asyncio
    async def test_a_blocked_host_logs_the_reason_only(self, caplog):
        from server.services.needs_you_send import Message, deliver

        caplog.set_level(logging.DEBUG)
        result = await deliver(
            "teams",
            {},
            {"webhook_url": _TEAMS},
            Message("t", "b"),
            resolver=_resolver("10.1.2.3"),
        )
        assert result == "blocked"
        assert "fake-0000" not in caplog.text


class TestClassify:
    def _spec(self, tmp_path, metadata: dict | None = None) -> str:
        directory = tmp_path / ".workpilot" / "specs" / "012-x"
        directory.mkdir(parents=True)
        (directory / "spec.md").write_text("# spec", encoding="utf-8")
        if metadata is not None:
            (directory / "task_metadata.json").write_text(
                json.dumps(metadata), encoding="utf-8"
            )
        return str(tmp_path)

    @pytest.mark.parametrize(
        ("phase", "status", "event"),
        [
            ("build", "succeeded", "review_ready"),
            ("qa", "succeeded", "review_ready"),
            ("merge", "succeeded", None),
            ("pr", "succeeded", None),
            ("build", "failed", "failed"),
            ("spec", "failed", "failed"),
            ("build", "cancelled", None),
        ],
    )
    def test_the_moments(self, phase, status, event):
        from server.services.needs_you import classify

        assert classify(phase, status, None, "012-x") == event

    def test_a_plan_waiting_for_approval(self, tmp_path):
        from server.services import needs_you

        root = self._spec(tmp_path)
        needs_you.set_approval_check(lambda directory: True)
        assert needs_you.classify("spec", "succeeded", root, "012-x") == "plan_review"
        needs_you.set_approval_check(lambda directory: False)
        assert needs_you.classify("spec", "succeeded", root, "012-x") is None

    def test_without_the_board_no_plan_is_announced(self, tmp_path):
        from server.services import needs_you

        root = self._spec(tmp_path)
        assert needs_you.classify("spec", "succeeded", root, "012-x") is None

    def test_a_card_without_review_built_on(self, tmp_path):
        from server.services import needs_you

        root = self._spec(tmp_path, {"requireReviewBeforeCoding": False})
        needs_you.set_approval_check(lambda directory: True)
        assert needs_you.classify("spec", "succeeded", root, "012-x") == "review_ready"

    def test_a_card_id_cannot_leave_the_specs(self, tmp_path):
        from server.services import needs_you

        self._spec(tmp_path)
        needs_you.set_approval_check(lambda directory: True)
        assert needs_you.classify("spec", "succeeded", str(tmp_path), "../..") is None

    def test_the_message_carries_no_card_text(self):
        from server.services.needs_you import message

        text = message("plan_review", "fr", "Payments", "012-secret-refunds")
        assert text.title == "Un plan t'attend"
        assert "012" in text.body and "Payments" in text.body
        assert "secret" not in text.title + text.body
        assert message("failed", "de", "P", "001-x").title == (
            "Task stopped on an error"
        )


async def _channel_row(db, user_id: str, channel: str):
    from server.db.models import NeedsYouChannel
    from sqlalchemy import select

    return await db.scalar(
        select(NeedsYouChannel).where(
            NeedsYouChannel.user_id == user_id, NeedsYouChannel.channel == channel
        )
    )


class TestStorage:
    @pytest.mark.asyncio
    async def test_secrets_are_encrypted_and_masked(self):
        from server.services import needs_you

        async with await _fresh_db() as db:
            me = await _user(db, "me@example.com")
            await needs_you.save_channel(
                db, me.id, "telegram", {"bot_token": _BOT, "chat_id": "42"}
            )
            await needs_you.save_channel(db, me.id, "teams", {"webhook_url": _TEAMS})
            row = await _channel_row(db, me.id, "telegram")
            assert _BOT not in row.encrypted_secrets
            assert _BOT not in row.settings
            teams = await _channel_row(db, me.id, "teams")
            assert "fake-0000" not in teams.encrypted_secrets + teams.settings

            shown = await needs_you.overview(db, me.id)
        dumped = json.dumps(shown)
        assert _BOT not in dumped and "fake-0000" not in dumped
        assert shown["channels"]["telegram"] == {
            "configured": True,
            "enabled": True,
            "readable": True,
            "bot_token": needs_you.MASK,
            "chat_id": "42",
        }
        assert shown["channels"]["ntfy"] == {"configured": False}
        assert shown["available"] is False and shown["vault"] is True

    @pytest.mark.asyncio
    async def test_the_mask_keeps_the_stored_secret(self):
        from server.services import needs_you

        async with await _fresh_db() as db:
            me = await _user(db, "keep@example.com")
            await needs_you.save_channel(
                db,
                me.id,
                "ntfy",
                {"topic": _TOPIC, "access_token": _NTFY_TOKEN},
            )
            await needs_you.save_channel(
                db,
                me.id,
                "ntfy",
                {
                    "server": "https://ntfy.sh",
                    "topic": needs_you.MASK,
                    "enabled": False,
                },
            )
            row = await _channel_row(db, me.id, "ntfy")
            assert row.enabled is False
            assert needs_you._secrets_of(row) == {
                "topic": _TOPIC,
                "access_token": _NTFY_TOKEN,
            }
            # An empty string clears the optional token.
            await needs_you.save_channel(
                db, me.id, "ntfy", {"topic": None, "access_token": ""}
            )
            row = await _channel_row(db, me.id, "ntfy")
            assert needs_you._secrets_of(row) == {"topic": _TOPIC}

    @pytest.mark.asyncio
    async def test_no_master_key_no_storage(self, monkeypatch):
        from server.services import needs_you

        monkeypatch.delenv("WORKPILOT_SECRETS_MASTER_KEY")
        server_config.reset_settings_cache()
        async with await _fresh_db() as db:
            me = await _user(db, "nokey@example.com")
            with pytest.raises(needs_you.VaultUnavailable):
                await needs_you.save_channel(
                    db, me.id, "teams", {"webhook_url": _TEAMS}
                )
            assert await _channel_row(db, me.id, "teams") is None

    @pytest.mark.asyncio
    async def test_an_invalid_destination_is_not_stored(self):
        from server.services import needs_you
        from server.services.needs_you_send import ChannelRejected

        async with await _fresh_db() as db:
            me = await _user(db, "bad@example.com")
            with pytest.raises(ChannelRejected):
                await needs_you.save_channel(
                    db, me.id, "teams", {"webhook_url": "https://evil.example/x"}
                )
            with pytest.raises(ChannelRejected):
                # No topic stored, none given.
                await needs_you.save_channel(db, me.id, "ntfy", {"topic": None})
            assert await _channel_row(db, me.id, "teams") is None

    @pytest.mark.asyncio
    async def test_preferences(self):
        from server.services import needs_you

        async with await _fresh_db() as db:
            me = await _user(db, "prefs@example.com")
            await needs_you.save_preferences(db, me.id, {"review_ready": False}, "fr")
            shown = await needs_you.overview(db, me.id)
        assert shown["locale"] == "fr"
        assert shown["events"] == {
            "plan_review": True,
            "review_ready": False,
            "failed": True,
        }


class TestNotify:
    @pytest.mark.asyncio
    async def test_off_by_default(self, monkeypatch):
        from server.services import needs_you

        assert server_config.get_settings().needs_you_enabled is False
        called = []
        monkeypatch.setattr(needs_you, "_notify", lambda *a: called.append(a))
        needs_you.notify_needs_you("p", "001-x", "build", "failed", "u")
        await asyncio.sleep(0)
        assert called == [] and not needs_you._background

    @pytest.mark.asyncio
    async def test_it_runs_in_the_background_and_never_fails(self, monkeypatch):
        from server.services import needs_you

        _enable(monkeypatch)
        called = []

        async def broken(*args):
            called.append(args)
            raise httpx.ConnectError("down")

        monkeypatch.setattr(needs_you, "_notify", broken)
        needs_you.notify_needs_you("p", "001-x", "build", "failed", "u")
        needs_you.notify_needs_you("p", "001-x", "build", "running", "u")
        needs_you.notify_needs_you("p", "001-x", "build", "failed", None)
        assert called == []  # scheduled, not awaited by the caller
        await asyncio.gather(*needs_you._background)
        assert called == [("p", "001-x", "build", "failed", "u")]

    @pytest.mark.asyncio
    async def test_end_to_end(self, monkeypatch):
        from server.db.models import Organization, Project
        from server.services import needs_you
        from sqlalchemy import select

        async with await _fresh_db() as db:
            me = await _user(db, "e2e@example.com")
            other = await _user(db, "other@example.com")
            org = await db.scalar(select(Organization).limit(1))
            project = Project(
                name="Payments",
                org_id=org.id,
                repo_url="https://example.com/r.git",
                server_path="/srv/r",
            )
            db.add(project)
            await db.commit()
            await needs_you.save_channel(
                db, me.id, "telegram", {"bot_token": _BOT, "chat_id": "42"}
            )
            await needs_you.save_channel(
                db, me.id, "teams", {"webhook_url": _TEAMS, "enabled": False}
            )
            await needs_you.save_channel(
                db, other.id, "telegram", {"bot_token": _BOT, "chat_id": "99"}
            )
            await needs_you.save_preferences(db, me.id, {"review_ready": False}, "fr")
            project_id, user_id = project.id, me.id

        sent: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            sent.append(request)
            return httpx.Response(200, json={"ok": True})

        real_send_all = needs_you._send_all

        async def fake_send_all(rows, text, client=None, resolver=None):
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
                return await real_send_all(rows, text, c, _PUBLIC)

        monkeypatch.setattr(needs_you, "_send_all", fake_send_all)
        await needs_you._notify(project_id, "003-x", "build", "failed", user_id)
        # Muted: nothing.
        await needs_you._notify(project_id, "003-x", "qa", "succeeded", user_id)

        assert len(sent) == 1  # Telegram only: Teams is off, the other person not told
        body = json.loads(sent[0].content)
        assert body["chat_id"] == "42"
        assert body["text"].startswith(
            "Tâche arrêtée sur une erreur\nPayments, carte 003"
        )


class TestRoutes:
    @pytest.fixture
    def make_client(self, monkeypatch):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from server.auth.deps import CurrentUser, get_current_user
        from server.authz.principal import Principal, get_principal
        from server.routers import needs_you as router_module

        clients = []

        def make(permissions: frozenset[str], email: str = "route@example.com"):
            state: dict = {}

            async def setup():
                async with await _fresh_db() as db:
                    state["user"] = await _user(db, email)

            asyncio.run(setup())
            user = state["user"]
            app = FastAPI()
            app.include_router(router_module.router)
            app.dependency_overrides[get_current_user] = lambda: CurrentUser(
                id=user.id, email=user.email, display_name="P", role="member"
            )
            app.dependency_overrides[get_principal] = lambda: Principal(
                id=user.id, permissions=permissions
            )
            client = TestClient(app)
            client.__enter__()
            clients.append(client)
            client.user_id = user.id
            return client

        yield make
        for client in clients:
            client.__exit__(None, None, None)

    _ALL = frozenset({"task.read", "agent.execute"})

    def test_read_save_delete(self, make_client):
        client = make_client(self._ALL)
        assert client.get("/users/me/needs-you").json()["channels"]["teams"] == {
            "configured": False
        }
        saved = client.put(
            "/users/me/needs-you/channels/teams", json={"webhook_url": _TEAMS}
        )
        assert saved.status_code == 200, saved.text
        shown = client.get("/users/me/needs-you")
        assert "fake-0000" not in shown.text
        assert shown.json()["channels"]["teams"]["webhook_url"] == "********"
        gone = client.delete("/users/me/needs-you/channels/teams")
        assert gone.json() == {"deleted": True}

    def test_a_refusal_names_the_rule_not_the_input(self, make_client):
        client = make_client(self._ALL)
        refused = client.put(
            "/users/me/needs-you/channels/teams",
            json={"webhook_url": "https://evil.example.com/secret-path"},
        )
        assert refused.status_code == 400
        assert "secret-path" not in refused.text
        assert refused.json()["detail"] == (
            "Not a Microsoft Teams webhook or Workflows URL"
        )

    def test_no_master_key_is_a_conflict(self, make_client, monkeypatch):
        client = make_client(self._ALL)
        monkeypatch.delenv("WORKPILOT_SECRETS_MASTER_KEY")
        server_config.reset_settings_cache()
        refused = client.put(
            "/users/me/needs-you/channels/teams", json={"webhook_url": _TEAMS}
        )
        assert refused.status_code == 409

    def test_storing_and_testing_need_agent_execute(self, make_client):
        client = make_client(frozenset({"task.read"}))
        assert client.get("/users/me/needs-you").status_code == 200
        assert (
            client.put(
                "/users/me/needs-you/channels/teams", json={"webhook_url": _TEAMS}
            ).status_code
            == 403
        )
        assert client.post("/users/me/needs-you/channels/teams/test").status_code == 403
        assert client.delete("/users/me/needs-you/channels/teams").status_code == 200

    def test_reading_needs_task_read(self, make_client):
        client = make_client(frozenset())
        assert client.get("/users/me/needs-you").status_code == 403
        assert client.delete("/users/me/needs-you/channels/teams").status_code == 403
        assert client.put("/users/me/needs-you/preferences", json={}).status_code == 403

    def test_test_is_off_when_the_server_is(self, make_client):
        client = make_client(self._ALL)
        client.put("/users/me/needs-you/channels/teams", json={"webhook_url": _TEAMS})
        assert client.post("/users/me/needs-you/channels/teams/test").status_code == 409

    def test_test_sends_and_is_rate_limited(self, make_client, monkeypatch):
        from server.services import needs_you

        _enable(monkeypatch)
        client = make_client(self._ALL)
        assert client.post("/users/me/needs-you/channels/teams/test").status_code == 404
        needs_you._last_test.clear()
        client.put("/users/me/needs-you/channels/teams", json={"webhook_url": _TEAMS})

        async def fake_send_all(rows, text, client=None, resolver=None):
            assert text.title == "WorkPilot test"
            return {row.channel: "sent" for row in rows}

        monkeypatch.setattr(needs_you, "_send_all", fake_send_all)
        ok = client.post("/users/me/needs-you/channels/teams/test")
        assert ok.json() == {"result": "sent"}
        again = client.post("/users/me/needs-you/channels/teams/test")
        assert again.status_code == 429

    def test_unknown_channel_and_moment(self, make_client):
        client = make_client(self._ALL)
        assert (
            client.put("/users/me/needs-you/channels/slack", json={}).status_code == 422
        )
        assert client.delete("/users/me/needs-you/channels/slack").status_code == 404
        assert (
            client.put(
                "/users/me/needs-you/preferences", json={"events": {"merged": True}}
            ).status_code
            == 400
        )

    def test_a_person_only_sees_their_own(self, make_client):
        first = make_client(self._ALL, "first@example.com")
        first.put(
            "/users/me/needs-you/channels/telegram",
            json={"bot_token": _BOT, "chat_id": "42"},
        )
        second = make_client(self._ALL, "second@example.com")
        assert second.get("/users/me/needs-you").json()["channels"]["telegram"] == {
            "configured": False
        }
        assert second.delete("/users/me/needs-you/channels/telegram").json() == {
            "deleted": False
        }

    def test_the_route_is_mounted_in_server_mode(self):
        source = (_BACKEND / "server" / "integration.py").read_text(encoding="utf-8")
        assert '("server.routers.needs_you", "needs-you")' in source

    def test_the_board_installs_the_approval_check(self):
        source = (_BACKEND / "shared_board" / "api.py").read_text(encoding="utf-8")
        assert "set_approval_check(_plan_awaits_approval)" in source

    def test_the_run_manager_calls_it(self):
        source = (_BACKEND / "server" / "services" / "run_manager.py").read_text(
            encoding="utf-8"
        )
        assert (
            "notify_needs_you(project_id, spec_name, phase, status, user_id)" in source
        )
