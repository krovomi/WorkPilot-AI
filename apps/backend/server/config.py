"""Server-mode settings.

All configuration is read from environment variables (loaded from
``.env-files/.env`` by the existing dotenv bootstrap). Settings are frozen
at first access via :func:`get_settings`; tests can call
:func:`reset_settings_cache` after monkeypatching the environment.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

_TRUTHY = {"1", "true", "yes", "on"}


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUTHY


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        logger.warning(
            "Invalid integer for %s=%r, using default %d", name, raw, default
        )
        return default


@dataclass(frozen=True)
class ServerSettings:
    """Immutable snapshot of the server-mode configuration."""

    # Master switch: when False, provider_api behaves exactly as before
    # (single-user local mode, no auth middleware, no DB).
    server_mode: bool

    # SQLAlchemy async URL. PostgreSQL in production
    # (postgresql+asyncpg://user:pass@host/db), SQLite for dev/tests
    # (sqlite+aiosqlite:///path/to.db).
    database_url: str

    # HS256 secret for WorkPilot-issued access/refresh JWTs.
    jwt_secret: str
    jwt_issuer: str
    access_token_ttl_minutes: int
    refresh_token_ttl_days: int

    # Microsoft Entra ID (OIDC). Both empty => Entra login disabled,
    # only local accounts work.
    entra_tenant_id: str
    entra_client_id: str

    # Fernet key (urlsafe base64, 32 bytes) used to encrypt per-user
    # integration secrets (Azure PAT, Jira token) at rest.
    secrets_master_key: str

    # Directory where the server keeps its clones of registered repos.
    repos_root: Path

    # Maximum agent runs executing concurrently on this server.
    max_concurrent_runs: int

    @property
    def entra_enabled(self) -> bool:
        return bool(self.entra_tenant_id and self.entra_client_id)

    @classmethod
    def from_env(cls) -> ServerSettings:
        server_mode = _env_bool("WORKPILOT_SERVER_MODE", False)

        jwt_secret = os.environ.get("WORKPILOT_JWT_SECRET", "")
        if server_mode and len(jwt_secret) < 32:
            raise RuntimeError(
                "WORKPILOT_SERVER_MODE is enabled but WORKPILOT_JWT_SECRET is missing "
                "or shorter than 32 characters. Generate one with: "
                'python -c "import secrets; print(secrets.token_urlsafe(48))"'
            )

        default_db = "sqlite+aiosqlite:///" + str(
            Path(__file__).resolve().parent.parent / "workpilot_server.sqlite3"
        ).replace("\\", "/")

        repos_root = Path(
            os.environ.get("WORKPILOT_REPOS_ROOT")
            or (Path.home() / ".workpilot" / "server-repos")
        )

        return cls(
            server_mode=server_mode,
            database_url=os.environ.get("WORKPILOT_DATABASE_URL", default_db),
            jwt_secret=jwt_secret,
            jwt_issuer=os.environ.get("WORKPILOT_JWT_ISSUER", "workpilot"),
            access_token_ttl_minutes=_env_int("WORKPILOT_ACCESS_TOKEN_TTL_MINUTES", 15),
            refresh_token_ttl_days=_env_int("WORKPILOT_REFRESH_TOKEN_TTL_DAYS", 14),
            entra_tenant_id=os.environ.get("WORKPILOT_ENTRA_TENANT_ID", ""),
            entra_client_id=os.environ.get("WORKPILOT_ENTRA_CLIENT_ID", ""),
            secrets_master_key=os.environ.get("WORKPILOT_SECRETS_MASTER_KEY", ""),
            repos_root=repos_root,
            max_concurrent_runs=_env_int("WORKPILOT_MAX_CONCURRENT_RUNS", 3),
        )


_settings: ServerSettings | None = None


def get_settings() -> ServerSettings:
    """Return the cached settings snapshot (created on first call)."""
    global _settings
    if _settings is None:
        _settings = ServerSettings.from_env()
    return _settings


def reset_settings_cache() -> None:
    """Drop the cached snapshot (tests only)."""
    global _settings
    _settings = None
