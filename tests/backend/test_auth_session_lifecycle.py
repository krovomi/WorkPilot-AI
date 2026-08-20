"""Refresh-session lifecycle guarantees.

Two properties that a short access-token TTL alone does not give you:

- Changing a password must invalidate every refresh session issued under the
  old password, otherwise a token stolen beforehand keeps working for its
  full TTL and the password change buys nothing.
- Presenting an already-rotated (revoked) refresh token means the token
  leaked *or* the client is broken; either way the whole family must die
  rather than letting an attacker and the legitimate client both keep
  rotating in parallel.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402

_VALID_SECRET = "x" * 48
_PASSWORD = "correct-horse-battery-staple"
_NEW_PASSWORD = "another-perfectly-fine-passphrase"


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "sessions.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


async def _fresh_db():
    """A session against a freshly created schema for this test's sqlite file."""
    from server.db import engine as db_engine

    # Drop any engine cached by a previous test so the new URL is honoured.
    db_engine._engine = None
    db_engine._session_factory = None
    await db_engine.init_db()
    return db_engine.get_session_factory()()


async def _make_user(db):
    from server.auth.local import create_local_user

    return await create_local_user(
        db, email="dev@example.com", password=_PASSWORD, display_name="Dev"
    )


async def _live_session_count(db, user_id: str) -> int:
    from server.db.models import AuthSession
    from sqlalchemy import func, select

    return await db.scalar(
        select(func.count())
        .select_from(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
    )


@pytest.mark.asyncio
async def test_password_change_revokes_every_live_session():
    from server.auth.jwt_tokens import (
        TokenError,
        issue_token_pair,
        rotate_refresh_token,
    )
    from server.auth.local import change_password

    async with await _fresh_db() as db:
        user = await _make_user(db)
        laptop = await issue_token_pair(db, user)
        phone = await issue_token_pair(db, user)
        assert await _live_session_count(db, user.id) == 2

        await change_password(db, user, _PASSWORD, _NEW_PASSWORD)

        assert await _live_session_count(db, user.id) == 0
        for pair in (laptop, phone):
            with pytest.raises(TokenError):
                await rotate_refresh_token(db, pair.refresh_token)


@pytest.mark.asyncio
async def test_replaying_a_rotated_refresh_token_kills_the_family():
    from server.auth.jwt_tokens import (
        TokenError,
        issue_token_pair,
        rotate_refresh_token,
    )

    async with await _fresh_db() as db:
        user = await _make_user(db)
        first = await issue_token_pair(db, user)
        second, _ = await rotate_refresh_token(db, first.refresh_token)

        # The attacker replays the token the legitimate client already used.
        with pytest.raises(TokenError, match="revoked"):
            await rotate_refresh_token(db, first.refresh_token)

        # ...which must also invalidate the token the legitimate client holds.
        assert await _live_session_count(db, user.id) == 0
        with pytest.raises(TokenError):
            await rotate_refresh_token(db, second.refresh_token)
