"""Push notifications to the mobile app (``server.services.push``).

What is checked: a phone registers and unregisters only under its own
person, a person keeps a bounded list of phones, a message carries the
project's name, the card's number, the phase and its result but never the
card's text, Expo's "no longer registered" answers delete the token, and
nothing is sent unless the operator turned push on.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaa]"
_TOKEN_B = "ExpoPushToken[bbbbbbbbbbbbbbbb]"


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", "x" * 48)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "push.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
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


async def _tokens(db, user_id: str) -> set[str]:
    from server.db.models import PushDevice
    from sqlalchemy import select

    return set(
        await db.scalars(select(PushDevice.token).where(PushDevice.user_id == user_id))
    )


def _device(token: str, locale: str = "en"):
    from server.db.models import PushDevice

    return PushDevice(token=token, user_id="u", platform="ios", locale=locale)


class TestTokens:
    @pytest.mark.parametrize("token", [_TOKEN_A, _TOKEN_B])
    def test_expo_tokens_are_valid(self, token):
        from server.services.push import valid_token

        assert valid_token(token)

    @pytest.mark.parametrize(
        "token",
        [
            "",
            None,
            42,
            "ExponentPushToken[]",
            "ExponentPushToken[short]",
            "ExponentPushToken[has space here]",
            "https://evil.example/ExponentPushToken[aaaaaaaaaaaa]",
            "ExponentPushToken[" + "a" * 200 + "]",
        ],
    )
    def test_anything_else_is_refused(self, token):
        from server.services.push import valid_token

        assert not valid_token(token)


class TestRegistration:
    @pytest.mark.asyncio
    async def test_register_then_unregister(self):
        from server.services.push import register_device, unregister_device

        async with await _fresh_db() as db:
            me = await _user(db, "me@example.com")
            await register_device(db, me.id, _TOKEN_A, "ios", "fr")
            assert await _tokens(db, me.id) == {_TOKEN_A}
            assert await unregister_device(db, me.id, _TOKEN_A)
            assert await _tokens(db, me.id) == set()
            assert not await unregister_device(db, me.id, _TOKEN_A)

    @pytest.mark.asyncio
    async def test_a_phone_signed_in_elsewhere_moves_to_its_new_person(self):
        from server.services.push import register_device

        async with await _fresh_db() as db:
            first = await _user(db, "first@example.com")
            second = await _user(db, "second@example.com")
            await register_device(db, first.id, _TOKEN_A, "android", "en")
            await register_device(db, second.id, _TOKEN_A, "android", "en")
            assert await _tokens(db, first.id) == set()
            assert await _tokens(db, second.id) == {_TOKEN_A}

    @pytest.mark.asyncio
    async def test_only_the_owner_can_unregister(self):
        from server.services.push import register_device, unregister_device

        async with await _fresh_db() as db:
            owner = await _user(db, "owner@example.com")
            other = await _user(db, "other@example.com")
            await register_device(db, owner.id, _TOKEN_A, "ios", "en")
            assert not await unregister_device(db, other.id, _TOKEN_A)
            assert await _tokens(db, owner.id) == {_TOKEN_A}

    @pytest.mark.asyncio
    async def test_the_oldest_phones_go_beyond_the_limit(self):
        from server.services.push import MAX_DEVICES_PER_USER, register_device

        async with await _fresh_db() as db:
            me = await _user(db, "many@example.com")
            tokens = [
                f"ExponentPushToken[device{n:04d}xxxxxx]"
                for n in range(MAX_DEVICES_PER_USER + 2)
            ]
            for token in tokens:
                await register_device(db, me.id, token, "ios", "en")
                await asyncio.sleep(0.002)  # distinct last_seen_at
            assert await _tokens(db, me.id) == set(tokens[2:])

    @pytest.mark.asyncio
    async def test_an_unknown_locale_falls_back_to_english(self):
        from server.services.push import register_device

        async with await _fresh_db() as db:
            me = await _user(db, "de@example.com")
            device = await register_device(db, me.id, _TOKEN_A, "ios", "de")
            assert device.locale == "en"


class TestMessages:
    def test_one_message_per_phone_in_its_language(self):
        from server.services.push import build_messages

        messages = build_messages(
            [_device(_TOKEN_A, "en"), _device(_TOKEN_B, "fr")],
            "p1",
            "Payments",
            "012-add-refunds-to-the-secret-billing-flow",
            "build",
            "failed",
        )
        assert [m["to"] for m in messages] == [_TOKEN_A, _TOKEN_B]
        assert messages[0]["title"] == "Payments"
        assert messages[0]["body"] == "Build failed on card 012"
        assert messages[1]["body"] == "Build en échec sur la carte 012"
        assert messages[0]["data"] == {
            "type": "run_finished",
            "projectId": "p1",
            "cardId": "012-add-refunds-to-the-secret-billing-flow",
            "phase": "build",
            "status": "failed",
        }

    def test_the_cards_text_never_shows(self):
        from server.services.push import build_messages

        (message,) = build_messages(
            [_device(_TOKEN_A, "fr")],
            "p1",
            "P",
            "007-secret-plan",
            "merge",
            "succeeded",
        )
        assert message["body"] == "Fusion terminé sur la carte 007"
        visible = message["title"] + message["body"]
        assert "secret" not in visible

    def test_no_message_for_another_status(self):
        from server.services.push import build_messages

        assert (
            build_messages([_device(_TOKEN_A)], "p", "P", "001-x", "qa", "running")
            == []
        )


class TestPlanReview:
    """A plan waiting for approval comes with Approve and View buttons."""

    def test_a_plan_to_approve_carries_its_category(self):
        from server.services.push import PLAN_REVIEW_CATEGORY, build_messages

        en, fr = build_messages(
            [_device(_TOKEN_A, "en"), _device(_TOKEN_B, "fr")],
            "p1",
            "Payments",
            "012-secret-plan",
            "spec",
            "succeeded",
            spec_id="5d1c-77",
            awaiting_approval=True,
        )
        assert en["body"] == "Plan ready for your approval on card 012"
        assert fr["body"] == "Plan prêt à valider sur la carte 012"
        assert en["categoryId"] == PLAN_REVIEW_CATEGORY == "plan_review"
        assert en["data"]["type"] == "plan_review"
        assert en["data"]["specId"] == "5d1c-77"
        assert "secret" not in en["title"] + en["body"]

    @pytest.mark.parametrize(
        ("phase", "status"), [("spec", "failed"), ("build", "succeeded")]
    )
    def test_only_a_finished_spec_is_a_plan_to_approve(self, phase, status):
        from server.services.push import build_messages

        (message,) = build_messages(
            [_device(_TOKEN_A)],
            "p",
            "P",
            "001-x",
            phase,
            status,
            awaiting_approval=True,
        )
        assert "categoryId" not in message
        assert message["data"]["type"] == "run_finished"

    def test_it_reads_the_approval_the_build_checks(self, tmp_path):
        import shared_board.api  # noqa: F401 - installs the approval check
        from review.state import ReviewState
        from server.services.push import awaits_approval

        card = tmp_path / ".workpilot/specs/001-x"
        assert not awaits_approval(str(tmp_path), "001-x")  # no spec yet
        card.mkdir(parents=True)
        (card / "spec.md").write_text("# Spec", encoding="utf-8")
        assert awaits_approval(str(tmp_path), "001-x")
        (card / "task_metadata.json").write_text(
            json.dumps({"requireReviewBeforeCoding": False}), encoding="utf-8"
        )
        assert not awaits_approval(str(tmp_path), "001-x")
        (card / "task_metadata.json").unlink()
        ReviewState.load(card).approve(card, approved_by="a@example.com")
        assert not awaits_approval(str(tmp_path), "001-x")
        assert not awaits_approval(str(tmp_path), "../outside")


class TestSend:
    @pytest.mark.asyncio
    async def test_gone_tokens_are_returned(self):
        from server.services.push import EXPO_PUSH_URL, build_messages, send

        seen: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"status": "ok", "id": "1"},
                        {
                            "status": "error",
                            "message": "not registered",
                            "details": {"error": "DeviceNotRegistered"},
                        },
                    ]
                },
            )

        messages = build_messages(
            [_device(_TOKEN_A), _device(_TOKEN_B)], "p", "P", "001-x", "qa", "succeeded"
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            gone = await send(messages, client)
        assert gone == [_TOKEN_B]
        assert str(seen[0].url) == EXPO_PUSH_URL
        assert json.loads(seen[0].content) == messages

    @pytest.mark.asyncio
    async def test_other_errors_keep_the_token(self):
        from server.services.push import build_messages, send

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200,
                json={
                    "data": [
                        {"status": "error", "details": {"error": "MessageRateExceeded"}}
                    ]
                },
            )

        messages = build_messages(
            [_device(_TOKEN_A)], "p", "P", "001-x", "qa", "failed"
        )
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            assert await send(messages, client) == []

    @pytest.mark.asyncio
    async def test_nothing_to_send_makes_no_call(self):
        from server.services.push import send

        def handler(request: httpx.Request) -> httpx.Response:
            raise AssertionError("no call expected")

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            assert await send([], client) == []


class TestNotifyRunFinished:
    def test_push_is_off_by_default(self):
        assert server_config.get_settings().push_enabled is False

    @pytest.mark.asyncio
    async def test_nothing_is_scheduled_when_push_is_off(self, monkeypatch):
        from server.services import push

        called = []
        monkeypatch.setattr(push, "_notify", lambda *a: called.append(a))
        push.notify_run_finished("p", "001-x", "build", "failed", "u")
        await asyncio.sleep(0)
        assert called == []
        assert not push._background

    @pytest.mark.asyncio
    async def test_it_notifies_the_starter_when_push_is_on(self, monkeypatch):
        from server.services import push

        monkeypatch.setenv("WORKPILOT_PUSH_ENABLED", "1")
        server_config.reset_settings_cache()
        called = []

        async def fake(*args):
            called.append(args)

        monkeypatch.setattr(push, "_notify", fake)
        push.notify_run_finished("p", "001-x", "build", "failed", "u")
        push.notify_run_finished("p", "001-x", "build", "running", "u")
        push.notify_run_finished("p", "001-x", "build", "succeeded", None)
        await asyncio.gather(*push._background)
        assert called == [("p", "001-x", "build", "failed", "u", None)]

    @pytest.mark.asyncio
    async def test_a_failure_never_escapes(self, monkeypatch):
        from server.services import push

        monkeypatch.setenv("WORKPILOT_PUSH_ENABLED", "1")
        server_config.reset_settings_cache()

        async def broken(*args):
            raise httpx.ConnectError("down")

        monkeypatch.setattr(push, "_notify", broken)
        push.notify_run_finished("p", "001-x", "qa", "succeeded", "u")
        await asyncio.gather(*push._background)

    @pytest.mark.asyncio
    async def test_end_to_end_deletes_gone_tokens(self, monkeypatch):
        from server.db.models import Organization, Project
        from server.services import push
        from sqlalchemy import select

        async with await _fresh_db() as db:
            me = await _user(db, "e2e@example.com")
            org = await db.scalar(select(Organization).limit(1))
            project = Project(
                name="Payments",
                org_id=org.id,
                repo_url="https://example.com/r.git",
                server_path="/srv/r",
            )
            db.add(project)
            await db.commit()
            await push.register_device(db, me.id, _TOKEN_A, "ios", "en")
            await push.register_device(db, me.id, _TOKEN_B, "android", "fr")
            project_id, user_id = project.id, me.id

        sent: list[dict] = []
        real_send = push.send

        def handler(request: httpx.Request) -> httpx.Response:
            body = json.loads(request.content)
            sent.extend(body)
            tickets = [
                {"status": "error", "details": {"error": "DeviceNotRegistered"}}
                if m["to"] == _TOKEN_B
                else {"status": "ok"}
                for m in body
            ]
            return httpx.Response(200, json={"data": tickets})

        async def fake_send(messages, client=None):
            async with httpx.AsyncClient(
                transport=httpx.MockTransport(handler)
            ) as mock:
                return await real_send(messages, mock)

        monkeypatch.setattr(push, "send", fake_send)
        await push._notify(project_id, "003-x", "pr", "succeeded", user_id)

        assert {m["title"] for m in sent} == {"Payments"}
        async with await _fresh_db() as db:
            assert await _tokens(db, user_id) == {_TOKEN_A}


class TestRoute:
    @pytest.fixture
    def client(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from server.auth.deps import CurrentUser, get_current_user
        from server.routers import devices

        state: dict = {}

        async def setup():
            async with await _fresh_db() as db:
                state["user"] = await _user(db, "route@example.com")

        asyncio.run(setup())
        user = state["user"]
        app = FastAPI()
        app.include_router(devices.router)
        app.dependency_overrides[get_current_user] = lambda: CurrentUser(
            id=user.id, email=user.email, display_name="P", role="member"
        )
        with TestClient(app) as c:
            c.user_id = user.id
            yield c

    def test_register_and_remove(self, client):
        ok = client.put(
            "/users/me/devices",
            json={"token": _TOKEN_A, "platform": "ios", "locale": "fr"},
        )
        assert ok.status_code == 200, ok.text
        assert ok.json() == {"registered": True}
        gone = client.request("DELETE", "/users/me/devices", json={"token": _TOKEN_A})
        assert gone.json() == {"removed": True}

    @pytest.mark.parametrize(
        "body",
        [
            {"token": "not-a-token", "platform": "ios"},
            {"token": _TOKEN_A, "platform": "windows"},
        ],
    )
    def test_bad_registrations_are_refused(self, client, body):
        assert client.put("/users/me/devices", json=body).status_code == 400

    def test_the_route_is_mounted_in_server_mode(self):
        source = (_BACKEND / "server" / "integration.py").read_text(encoding="utf-8")
        assert '("server.routers.devices", "devices")' in source
