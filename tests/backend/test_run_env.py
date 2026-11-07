"""Server mode: an agent run never starts with the server's own secrets.

The run manager used to start every run with a copy of the API's process
environment, which in server mode holds the token signing key, the key to the
stored user secrets and the database password. A run executes an agent over
untrusted content; it gets the server environment minus those, plus its own.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]
_BACKEND = _REPO / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402
from server.services.run_env import (  # noqa: E402
    PASSED_TO_RUNS,
    RUN_ENV,
    SERVER_ONLY_ENV,
    run_environment,
)

_VALID_SECRET = "x" * 48


def test_server_secrets_are_stripped_and_run_values_win():
    server_env = {
        "PATH": "/usr/bin",
        "CLAUDE_CODE_OAUTH_TOKEN": "sk-test-0000",  # pragma: allowlist secret
        "WORKPILOT_JWT_SECRET": "j" * 48,
        "WORKPILOT_SECRETS_MASTER_KEY": "m" * 44,
        "WORKPILOT_DATABASE_URL": "postgresql+asyncpg://u:p@db/w",
        "WORKPILOT_SMTP_PASSWORD": "smtp-test-0000",  # pragma: allowlist secret
        "POSTGRES_PASSWORD": "pg-test-0000",  # pragma: allowlist secret
        "WORKPILOT_WS_TOKEN": "inherited",
        "WORKPILOT_WS_URL": "ws://127.0.0.1:8765",
    }
    env = run_environment(server_env, {"WORKPILOT_WS_TOKEN": "minted"})
    for name in SERVER_ONLY_ENV:
        assert name not in env
    assert env["WORKPILOT_WS_TOKEN"] == "minted"
    assert env["PATH"] == "/usr/bin"
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == "sk-test-0000"  # pragma: allowlist secret
    assert env["WORKPILOT_WS_URL"] == "ws://127.0.0.1:8765"


def test_an_inherited_run_value_is_never_passed_through():
    env = run_environment({"WORKPILOT_RUN_USER_ID": "someone-else"}, {})
    assert "WORKPILOT_RUN_USER_ID" not in env


def _server_env_names() -> set[str]:
    names: set[str] = set()
    sources = [
        *(_BACKEND / "server").rglob("*.py"),
        _REPO / "deploy" / "server-env.example",
    ]
    for path in sources:
        text = path.read_text(encoding="utf-8")
        names |= set(re.findall(r"\bWORKPILOT_[A-Z0-9_]+\b", text))
    return names


def test_every_server_setting_is_classified():
    """A new server variable must be stripped from runs, or passed on purpose."""
    known = SERVER_ONLY_ENV | RUN_ENV | PASSED_TO_RUNS
    unclassified = sorted(_server_env_names() - known)
    assert unclassified == [], (
        f"Classify these in apps/backend/server/services/run_env.py: {unclassified}"
    )


@pytest.mark.asyncio
async def test_the_run_manager_builds_the_env_and_scopes_the_token(
    monkeypatch, tmp_path
):
    import jwt as pyjwt

    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
    monkeypatch.setenv("WORKPILOT_SECRETS_MASTER_KEY", "m" * 44)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "env.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    try:
        from server.db import engine as db_engine
        from server.services.run_manager import RunManager

        db_engine._engine = None
        db_engine._session_factory = None
        await db_engine.init_db()

        env = await RunManager()._build_env("user-1", "run-1")
        assert "WORKPILOT_JWT_SECRET" not in env
        assert "WORKPILOT_SECRETS_MASTER_KEY" not in env
        assert "WORKPILOT_DATABASE_URL" not in env
        assert "WORKPILOT_SERVER_MODE" not in env
        assert env["WORKPILOT_RUN_USER_ID"] == "user-1"
        claims = pyjwt.decode(
            env["WORKPILOT_WS_TOKEN"],
            _VALID_SECRET,
            algorithms=["HS256"],
            options={"verify_iss": False},
        )
        assert claims["sub"] == "service:agent"
        assert claims["run"] == "run-1"
    finally:
        server_config.reset_settings_cache()
