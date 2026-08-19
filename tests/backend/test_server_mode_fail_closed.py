"""Server mode must fail CLOSED.

``mount_server_mode`` is what installs the bearer-token middleware. If it can
raise and the caller swallows the exception, the API boots with every
multi-user router mounted and no authentication in front of them — while the
operator believes server mode is active. These tests pin the two halves of that
contract: the mount raises loudly on a bad config, and once mounted the
middleware actually rejects unauthenticated traffic.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from server import config as server_config  # noqa: E402
from server.integration import mount_server_mode  # noqa: E402

_VALID_SECRET = "x" * 48


@pytest.fixture(autouse=True)
def _clean_settings(monkeypatch, tmp_path):
    """Every test gets a fresh settings snapshot and its own sqlite file."""
    for key in list(server_config.os.environ):
        if key.startswith("WORKPILOT_"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(
        "WORKPILOT_DATABASE_URL",
        "sqlite+aiosqlite:///" + str(tmp_path / "t.sqlite3").replace("\\", "/"),
    )
    server_config.reset_settings_cache()
    yield
    server_config.reset_settings_cache()


def test_mount_raises_when_server_mode_enabled_without_jwt_secret(monkeypatch):
    """A missing/short secret must abort the mount, not degrade to no-auth."""
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.delenv("WORKPILOT_JWT_SECRET", raising=False)

    from fastapi import FastAPI

    with pytest.raises(RuntimeError, match="WORKPILOT_JWT_SECRET"):
        mount_server_mode(FastAPI())


def test_mount_raises_on_short_jwt_secret(monkeypatch):
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", "tooshort")

    from fastapi import FastAPI

    with pytest.raises(RuntimeError, match="WORKPILOT_JWT_SECRET"):
        mount_server_mode(FastAPI())


def test_mount_is_a_noop_when_server_mode_disabled(monkeypatch):
    """Local desktop mode keeps its historical behaviour: no auth, no DB."""
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "0")

    from fastapi import FastAPI

    app = FastAPI()
    assert mount_server_mode(app) is False


def test_mounted_server_rejects_unauthenticated_requests(monkeypatch):
    """Once mounted, a non-public path must 401 without a bearer token."""
    monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
    monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)

    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()

    @app.get("/providers/configs")
    def _legacy_endpoint():  # pragma: no cover - must never be reached
        return {"configs": ["anthropic"]}

    assert mount_server_mode(app) is True

    with TestClient(app) as client:
        resp = client.get("/providers/configs")
        assert resp.status_code == 401
        assert resp.json()["detail"] == "Authentication required"

        # A malformed token is rejected too — never treated as anonymous-OK.
        resp = client.get(
            "/providers/configs", headers={"Authorization": "Bearer not-a-jwt"}
        )
        assert resp.status_code == 401

        # /health stays public so orchestrators can probe the container.
        assert client.get("/health").status_code in (200, 404)


class TestProviderCredentialGuard:
    """``/providers/config*`` is a single-user credential store.

    ``GET`` returns ``api_key`` in clear text and ``POST``/``DELETE`` rewrite a
    process-wide file with no tenant scoping. The auth middleware only proves
    *some* valid bearer token, so in server mode every member would otherwise
    be able to read and overwrite the deployment's LLM credentials.
    """

    @staticmethod
    def _guard():
        from provider_api import deny_in_server_mode

        return deny_in_server_mode

    def test_allowed_in_local_mode(self, monkeypatch):
        monkeypatch.setenv("WORKPILOT_SERVER_MODE", "0")
        server_config.reset_settings_cache()
        assert self._guard()() is None

    def test_allowed_when_server_config_is_absent(self, monkeypatch):
        """No server config at all is local mode, not a reason to blow up."""
        monkeypatch.delenv("WORKPILOT_SERVER_MODE", raising=False)
        server_config.reset_settings_cache()
        assert self._guard()() is None

    def test_blocked_in_server_mode(self, monkeypatch):
        from fastapi import HTTPException

        monkeypatch.setenv("WORKPILOT_SERVER_MODE", "1")
        monkeypatch.setenv("WORKPILOT_JWT_SECRET", _VALID_SECRET)
        server_config.reset_settings_cache()

        with pytest.raises(HTTPException) as excinfo:
            self._guard()()
        assert excinfo.value.status_code == 403
