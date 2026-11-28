"""``/users/me/ai-accounts``: each person's AI accounts on a shared server.

A key is saved once, kept encrypted, never read back by any route, and given
only to the runs its owner starts. Another person's account is unknown to
the caller (404), whatever their role.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from tests.server_routes.world import World

#: Obviously fake keys, shaped as the routes expect them.
KEY_PERSO = "sk-test-route-perso-0000"  # pragma: allowlist secret
KEY_CLIENT = "sk-test-route-client-0000"  # pragma: allowlist secret
KEY_NEW = "sk-test-route-new-0000"  # pragma: allowlist secret
BASE = "/users/me/ai-accounts"


@pytest.fixture
def vault(monkeypatch):
    """A secrets master key, as an operator sets one."""
    from cryptography.fernet import Fernet
    from server import config as server_config

    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    server_config.reset_settings_cache()


async def _add(world: World, who: str, provider: str, name: str, key: str) -> dict:
    return await world.ok(
        who, "POST", BASE, json={"provider": provider, "name": name, "key": key}
    )


async def _stored(world: World, account_id: str):
    from server.db.engine import get_session_factory
    from server.db.models import UserAiAccount

    async with get_session_factory()() as db:
        return await db.scalar(
            select(UserAiAccount).where(UserAiAccount.id == account_id)
        )


class TestOwnAccounts:
    async def test_the_first_account_of_a_provider_is_its_default(self, world, vault):
        perso = await _add(world, "contributor_a", "openai", "  Perso  ", KEY_PERSO)
        assert perso["name"] == "Perso"
        assert perso["is_default"] is True and perso["has_key"] is True
        client = await _add(world, "contributor_a", "openai", "Client X", KEY_CLIENT)
        assert client["is_default"] is False
        mistral = await _add(world, "contributor_a", "Mistral", "Perso", KEY_PERSO)
        assert mistral["provider"] == "mistral" and mistral["is_default"] is True

        answer = await world.call("contributor_a", "GET", BASE)
        listed = answer.json()
        # By provider, then in the order they were added.
        assert [a["id"] for a in listed["accounts"]] == [
            mistral["id"],
            perso["id"],
            client["id"],
        ]
        assert listed["defaults"] == {"openai": perso["id"], "mistral": mistral["id"]}
        assert "claude" in listed["providers"] and "openai" in listed["providers"]
        assert KEY_PERSO not in answer.text and KEY_CLIENT not in answer.text

    async def test_the_key_is_encrypted_at_rest(self, world, vault):
        made = await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        row = await _stored(world, made["id"])
        assert row is not None and KEY_PERSO not in row.encrypted_key

    async def test_switching_the_default_and_back_to_the_deployment(self, world, vault):
        perso = await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        client = await _add(world, "contributor_a", "openai", "Client", KEY_CLIENT)
        chosen = await world.ok(
            "contributor_a",
            "PUT",
            f"{BASE}/defaults/openai",
            json={"account_id": client["id"]},
        )
        assert chosen == {"provider": "openai", "account_id": client["id"]}
        listed = await world.ok("contributor_a", "GET", BASE)
        assert listed["defaults"] == {"openai": client["id"]}
        # None: the provider goes back to what the operator set.
        cleared = await world.ok(
            "contributor_a", "PUT", f"{BASE}/defaults/openai", json={"account_id": None}
        )
        assert cleared == {"provider": "openai", "account_id": None}
        listed = await world.ok("contributor_a", "GET", BASE)
        assert listed["defaults"] == {}
        assert {a["id"] for a in listed["accounts"]} == {perso["id"], client["id"]}

    async def test_rename_and_replace_the_key_without_reading_it(self, world, vault):
        made = await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        renamed = await world.ok(
            "contributor_a", "PATCH", f"{BASE}/{made['id']}", json={"name": "Maison"}
        )
        assert renamed["name"] == "Maison"
        assert renamed["key_set_at"] == made["key_set_at"]
        replaced = await world.call(
            "contributor_a", "PATCH", f"{BASE}/{made['id']}", json={"key": KEY_NEW}
        )
        assert replaced.status_code == 200 and KEY_NEW not in replaced.text
        assert replaced.json()["key_set_at"] >= made["key_set_at"]
        nothing = await world.call(
            "contributor_a", "PATCH", f"{BASE}/{made['id']}", json={}
        )
        assert nothing.status_code == 400

    async def test_deleting_the_default_promotes_no_other_account(self, world, vault):
        perso = await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        await _add(world, "contributor_a", "openai", "Client", KEY_CLIENT)
        gone = await world.ok("contributor_a", "DELETE", f"{BASE}/{perso['id']}")
        assert gone == {"deleted": True, "was_default": True}
        listed = await world.ok("contributor_a", "GET", BASE)
        assert listed["defaults"] == {}
        assert [a["name"] for a in listed["accounts"]] == ["Client"]

    async def test_each_change_is_audited_without_the_key(self, world, vault):
        from server.db.engine import get_session_factory
        from server.db.models import AuditLog

        made = await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        await world.ok(
            "contributor_a", "PATCH", f"{BASE}/{made['id']}", json={"key": KEY_NEW}
        )
        await world.ok("contributor_a", "DELETE", f"{BASE}/{made['id']}")
        async with get_session_factory()() as db:
            rows = list(
                await db.scalars(
                    select(AuditLog).where(AuditLog.action.like("ai_account.%"))
                )
            )
        assert [r.action for r in rows] == [
            "ai_account.created",
            "ai_account.updated",
            "ai_account.deleted",
        ]
        for row in rows:
            assert row.payload["account_id"] == made["id"]
            assert KEY_PERSO not in str(row.payload) and KEY_NEW not in str(row.payload)


class TestOtherPeople:
    async def test_another_persons_account_is_unknown(self, world, vault):
        made = await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        for who in ("maintainer_a", "admin_a", "member_b"):
            assert (await world.ok(who, "GET", BASE))["accounts"] == []
            for method, path, body in (
                ("PATCH", f"{BASE}/{made['id']}", {"name": "Mine"}),
                ("DELETE", f"{BASE}/{made['id']}", None),
                ("PUT", f"{BASE}/defaults/openai", {"account_id": made["id"]}),
            ):
                answer = await world.call(who, method, path, json=body)
                assert answer.status_code == 404, (who, method, answer.text)
        row = await _stored(world, made["id"])
        assert row is not None and row.name == "Perso" and row.is_default

    async def test_a_viewer_reads_their_list_but_saves_nothing(self, world, vault):
        assert (await world.ok("viewer_a", "GET", BASE))["accounts"] == []
        answer = await world.call(
            "viewer_a",
            "POST",
            BASE,
            json={"provider": "openai", "name": "Perso", "key": KEY_PERSO},
        )
        assert answer.status_code == 403
        assert "settings.account.write" in answer.json()["detail"]


class TestRefusals:
    @pytest.mark.parametrize(
        ("body", "detail"),
        [
            ({"provider": "aws", "name": "x", "key": KEY_PERSO}, "Unknown provider"),
            ({"provider": "openai", "name": "   ", "key": KEY_PERSO}, "A name"),
            ({"provider": "openai", "name": "x" * 81, "key": KEY_PERSO}, "A name"),
            ({"provider": "openai", "name": "x", "key": "   "}, "Invalid key"),
            ({"provider": "openai", "name": "x", "key": "sk two words"}, "Invalid key"),
        ],
    )
    async def test_an_account_the_server_will_not_keep(
        self, world, vault, body, detail
    ):
        answer = await world.call("contributor_a", "POST", BASE, json=body)
        assert answer.status_code == 400
        assert answer.json()["detail"].startswith(detail)
        assert KEY_PERSO not in answer.text
        assert (await world.ok("contributor_a", "GET", BASE))["accounts"] == []

    async def test_a_default_of_another_provider_is_refused(self, world, vault):
        made = await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        wrong = await world.call(
            "contributor_a",
            "PUT",
            f"{BASE}/defaults/mistral",
            json={"account_id": made["id"]},
        )
        assert wrong.status_code == 400
        unknown = await world.call(
            "contributor_a", "PUT", f"{BASE}/defaults/aws", json={"account_id": None}
        )
        assert unknown.status_code == 400

    async def test_a_person_keeps_a_bounded_number_of_accounts(
        self, world, vault, monkeypatch
    ):
        from server.services import ai_accounts

        monkeypatch.setattr(ai_accounts, "MAX_ACCOUNTS", 2)
        await _add(world, "contributor_a", "openai", "One", KEY_PERSO)
        await _add(world, "contributor_a", "openai", "Two", KEY_PERSO)
        answer = await world.call(
            "contributor_a",
            "POST",
            BASE,
            json={"provider": "openai", "name": "Three", "key": KEY_PERSO},
        )
        assert answer.status_code == 400 and "At most 2" in answer.json()["detail"]

    async def test_without_a_master_key_nothing_is_stored(self, world):
        answer = await world.call(
            "contributor_a",
            "POST",
            BASE,
            json={"provider": "openai", "name": "Perso", "key": KEY_PERSO},
        )
        assert answer.status_code == 500
        assert "WORKPILOT_SECRETS_MASTER_KEY is not set" in answer.json()["detail"]
        assert KEY_PERSO not in answer.text


class TestRuns:
    async def test_a_run_gets_its_starters_default_keys_only(
        self, world, vault, monkeypatch
    ):
        from server.services.run_manager import RunManager

        monkeypatch.setenv("OPENAI_API_KEY", "deployment-key")
        monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "deployment-token")
        await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        client = await _add(world, "contributor_a", "openai", "Client", KEY_CLIENT)
        await _add(world, "contributor_a", "huggingface", "Hub", KEY_NEW)
        mine = await RunManager()._build_env(world.users["contributor_a"], "run-1")
        assert mine["OPENAI_API_KEY"] == KEY_PERSO
        assert mine["HUGGINGFACE_API_KEY"] == KEY_NEW == mine["HF_TOKEN"]
        # A provider without an account keeps the deployment's credentials.
        assert mine["CLAUDE_CODE_OAUTH_TOKEN"] == "deployment-token"

        await world.ok(
            "contributor_a",
            "PUT",
            f"{BASE}/defaults/openai",
            json={"account_id": client["id"]},
        )
        mine = await RunManager()._build_env(world.users["contributor_a"], "run-2")
        assert mine["OPENAI_API_KEY"] == KEY_CLIENT

        theirs = await RunManager()._build_env(world.users["member_b"], "run-3")
        assert theirs["OPENAI_API_KEY"] == "deployment-key"
        assert KEY_PERSO not in theirs.values() and KEY_CLIENT not in theirs.values()

    async def test_a_key_the_vault_cannot_read_leaves_the_deployments(
        self, world, vault, monkeypatch, caplog
    ):
        from cryptography.fernet import Fernet
        from server import config as server_config
        from server.services.run_manager import RunManager

        monkeypatch.setenv("OPENAI_API_KEY", "deployment-key")
        await _add(world, "contributor_a", "openai", "Perso", KEY_PERSO)
        # The operator changed the master key since the account was saved.
        monkeypatch.setenv(
            "WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode()
        )
        server_config.reset_settings_cache()
        env = await RunManager()._build_env(world.users["contributor_a"], "run-1")
        assert env["OPENAI_API_KEY"] == "deployment-key"
        assert "Could not read the AI accounts" in caplog.text
        assert KEY_PERSO not in caplog.text
