"""Server mode: each person's integration tokens, and the runs that use them.

A run on a shared server acts on GitHub, GitLab or a tracker. Done with the
deployment's credentials, every action is the server's; done with the token of
the person who started the run, it is theirs. These tests hold the token to
its owner: set by them, never read back, given to their runs only, and never
quoted in a refusal.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_TOKEN = "ghp_" + "A" * 36  # pragma: allowlist secret


@pytest.fixture(autouse=True)
async def server(monkeypatch, tmp_path):
    from cryptography.fernet import Fernet
    from server.services.run_manager import USER_SECRET_ENV

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_") or key in USER_SECRET_ENV.values():
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "secrets.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    from server.db import engine as db_engine
    from server.db.models import User

    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    async with db_engine.get_session_factory()() as db:
        db.add_all(
            [
                User(id="u-ada", email="ada@x.test", display_name="Ada"),
                User(id="u-bob", email="bob@x.test", display_name="Bob"),
            ]
        )
        await db.commit()
    yield
    server_config.reset_settings_cache()


def _user(user_id: str):
    from server.auth.deps import CurrentUser

    return CurrentUser(
        id=user_id, email=f"{user_id}@x.test", display_name=user_id, role="member"
    )


async def _db():
    from server.db.engine import get_session_factory

    return get_session_factory()()


@pytest.mark.asyncio
async def test_a_token_is_set_by_its_owner_and_given_to_their_runs_only(monkeypatch):
    from server.routers.users import delete_my_secret, my_secret_kinds, set_my_secret
    from server.schemas import SetSecretRequest
    from server.services.run_manager import RunManager

    async with await _db() as db:
        await set_my_secret(
            SetSecretRequest(kind="github_token", value=f"  {_TOKEN}\n"),
            _user("u-ada"),
            db,
        )
    async with await _db() as db:
        listed = await my_secret_kinds(_user("u-ada"), db)
        assert listed.kinds == ["github_token"]
        assert _TOKEN not in listed.model_dump_json()
        assert (await my_secret_kinds(_user("u-bob"), db)).kinds == []

    assert (await RunManager()._build_env("u-ada", "run-1"))["GITHUB_TOKEN"] == _TOKEN
    assert "GITHUB_TOKEN" not in await RunManager()._build_env("u-bob", "run-2")
    # A token the operator set for the deployment never replaces the person's.
    monkeypatch.setenv("GITHUB_TOKEN", "deployment-token")
    assert (await RunManager()._build_env("u-ada", "run-1"))["GITHUB_TOKEN"] == _TOKEN
    monkeypatch.delenv("GITHUB_TOKEN")

    async with await _db() as db:
        assert await delete_my_secret("github_token", _user("u-ada"), db) == {
            "deleted": True
        }
    assert "GITHUB_TOKEN" not in await RunManager()._build_env("u-ada", "run-3")


@pytest.mark.asyncio
async def test_a_refused_token_is_never_quoted_back():
    from server.routers.users import set_my_secret
    from server.schemas import SetSecretRequest

    for kind, value in (
        ("github_token", "   "),
        ("github_token", _TOKEN * 200),
        ("ssh_private_key", _TOKEN),
    ):
        async with await _db() as db:
            with pytest.raises(HTTPException) as refused:
                await set_my_secret(
                    SetSecretRequest(kind=kind, value=value), _user("u-ada"), db
                )
        assert refused.value.status_code == 400
        assert _TOKEN not in str(refused.value.detail)
        assert kind != "ssh_private_key" or kind not in str(refused.value.detail)


def test_the_request_model_never_rejects_with_the_value():
    """A validation error quotes its input: the value is checked by the route."""
    from server.schemas import SetSecretRequest

    assert SetSecretRequest(kind="github_token", value="").value == ""
