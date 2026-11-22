"""Server-mode settings.

All configuration is read from environment variables (loaded from
``.env-files/.env`` by the existing dotenv bootstrap). Settings are frozen
at first access via :func:`get_settings`; tests can call
:func:`reset_settings_cache` after monkeypatching the environment.
"""

from __future__ import annotations

import logging
import os
import re
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


_HOST = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$"
)


def _hosts(value: str, default: str, variable: str) -> tuple[str, ...]:
    """``default`` and the hosts listed, lowercased; a malformed one is left out."""
    hosts = [default]
    for raw in value.split(","):
        host = raw.strip().lower()
        if not host:
            continue
        if _HOST.match(host) and host not in hosts:
            hosts.append(host)
        else:
            logger.warning("Ignoring invalid host in %s: %r", variable, raw[:100])
    return tuple(hosts)


def _gitlab_hosts(value: str) -> tuple[str, ...]:
    """gitlab.com and the hosts listed, lowercased; a malformed one is left out."""
    return _hosts(value, "gitlab.com", "WORKPILOT_GITLAB_HOSTS")


_LOOPBACK = {"localhost", "127.0.0.1", "::1"}


def oidc_url(value: str, *, issuer: bool = False) -> str:
    """``value`` when it is an https URL (http only on loopback), else "".

    No user name or password in it, no fragment, and an issuer has no query
    either (OpenID Connect Discovery 1.0, section 3). A trailing slash of an
    issuer is dropped: the issuer is compared as a string.
    """
    from urllib.parse import urlsplit

    value = value.strip()
    if not value or len(value) > 2000:
        return ""
    try:
        parts = urlsplit(value)
        host = parts.hostname or ""
    except ValueError:
        return ""
    secure = parts.scheme == "https" or (parts.scheme == "http" and host in _LOOPBACK)
    if not secure or not host or parts.username or parts.password:
        return ""
    if parts.fragment or (issuer and parts.query):
        return ""
    return value.rstrip("/") if issuer else value


def _oidc_name(value: str) -> str:
    """The sign-in button's name for the identity provider: short, plain."""
    name = " ".join(value.split())[:40]
    return name if name.isprintable() and name else "SSO"


#: A scope token as RFC 6749 (section 3.3) spells it.
_SCOPE_TOKEN = re.compile(r"^[\x21\x23-\x5B\x5D-\x7E]{1,100}$")


def _oidc_scopes(value: str) -> str:
    """The scopes asked for, ``openid`` first; the default is the usual three."""
    scopes = [t for t in value.split() if _SCOPE_TOKEN.match(t)][:20]
    if not scopes:
        scopes = ["openid", "profile", "email"]
    return " ".join(["openid", *(t for t in scopes if t != "openid")])


#: Who may approve the spec of a card they created (``WORKPILOT_SELF_APPROVAL``).
SELF_APPROVAL_POLICIES = ("allow", "deny", "when-alone")


def _self_approval(value: str) -> str:
    value = value.strip().lower()
    if not value:
        return "when-alone"
    if value not in SELF_APPROVAL_POLICIES:
        logger.warning(
            "Invalid WORKPILOT_SELF_APPROVAL=%r, using 'when-alone'", value[:40]
        )
        return "when-alone"
    return value


#: How critical a card is, lowest first (``server/authz/approval_policy.py``).
CRITICALITIES = ("low", "medium", "high")
#: More approvals than this for one card is a typo, not a policy.
MAX_QUORUM = 10
#: A role slug as ``server/authz/roles.py`` and the admin console write them.
_ROLE_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,79}$")


def _per_criticality(variable: str, value: str) -> dict[str, str]:
    """``low=1,high=3`` as ``{"low": "1", "high": "3"}``; unknown levels left out."""
    found: dict[str, str] = {}
    for item in value.split(","):
        if not item.strip():
            continue
        level, sep, raw = item.partition("=")
        level = level.strip().lower()
        if not sep or level not in CRITICALITIES:
            logger.warning("Ignoring %r in %s", item.strip()[:60], variable)
            continue
        found[level] = raw.strip()
    return found


def _approval_quorum(value: str) -> tuple[tuple[str, int], ...]:
    """How many approvals a card of each criticality needs (1 unless set)."""
    given = _per_criticality("WORKPILOT_APPROVAL_QUORUM", value)
    quorum: list[tuple[str, int]] = []
    for level in CRITICALITIES:
        raw = given.get(level, "1")
        needed = int(raw) if raw.isdigit() else 0
        if not 1 <= needed <= MAX_QUORUM:
            logger.warning(
                "Invalid WORKPILOT_APPROVAL_QUORUM for %s: %r, using 1", level, raw[:20]
            )
            needed = 1
        quorum.append((level, needed))
    return tuple(quorum)


def _approval_roles(value: str) -> tuple[tuple[str, tuple[str, ...]], ...]:
    """The roles one of a card's approvers must hold, per criticality."""
    given = _per_criticality("WORKPILOT_APPROVAL_ROLES", value)
    roles: list[tuple[str, tuple[str, ...]]] = []
    for level in CRITICALITIES:
        slugs: list[str] = []
        for raw in given.get(level, "").split("+"):
            slug = raw.strip().lower()
            if not slug:
                continue
            if _ROLE_SLUG.match(slug) and slug not in slugs:
                slugs.append(slug)
            else:
                logger.warning(
                    "Ignoring role %r in WORKPILOT_APPROVAL_ROLES", raw.strip()[:80]
                )
        roles.append((level, tuple(slugs[:5])))
    return tuple(roles)


#: The longest a card waits before it escalates: 30 days.
MAX_ESCALATION_HOURS = 720
#: Who hears of a card that waited too long, unless the deployment names others.
DEFAULT_ESCALATION_ROLES = ("owner", "admin")


def _escalation_hours(value: str) -> tuple[tuple[str, int], ...]:
    """Hours a card of each criticality waits before it escalates; 0 is never.

    ``24`` for every level, or ``low=72,medium=24,high=4``; a level left out
    never escalates.
    """
    value = value.strip()
    if value.isdigit():
        given = dict.fromkeys(CRITICALITIES, value)
    else:
        given = _per_criticality("WORKPILOT_APPROVAL_ESCALATION_HOURS", value)
    hours: list[tuple[str, int]] = []
    for level in CRITICALITIES:
        raw = given.get(level, "0")
        wait = int(raw) if raw.isdigit() else -1
        if not 0 <= wait <= MAX_ESCALATION_HOURS:
            logger.warning(
                "Invalid WORKPILOT_APPROVAL_ESCALATION_HOURS for %s: %r, never",
                level,
                raw[:20],
            )
            wait = 0
        hours.append((level, wait))
    return tuple(hours)


def _escalation_roles(value: str) -> tuple[str, ...]:
    """The role slugs of the second group of approvers (``owner+admin`` unless set)."""
    slugs: list[str] = []
    for raw in value.replace(",", "+").split("+"):
        slug = raw.strip().lower()
        if not slug:
            continue
        if _ROLE_SLUG.match(slug) and slug not in slugs:
            slugs.append(slug)
        else:
            logger.warning(
                "Ignoring role %r in WORKPILOT_APPROVAL_ESCALATION_ROLES",
                raw.strip()[:80],
            )
    return tuple(slugs[:5]) or DEFAULT_ESCALATION_ROLES


def _stream_url(value: str) -> str:
    value = value.strip().rstrip("/")
    return value if value.startswith(("ws://", "wss://")) else ""


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

    # Any OpenID Connect provider (Okta, Google, Keycloak, Auth0...), by its
    # issuer URL, whose discovery document gives the endpoints and keys.
    # Empty issuer or client => this sign-in is off. Public client with PKCE:
    # no client secret.
    oidc_issuer: str
    oidc_client_id: str
    oidc_name: str
    oidc_scopes: str

    # Approving the spec of a card one created: "allow", "deny", or
    # "when-alone" (refused while another member of the project may approve).
    self_approval: str

    # How many people approve a card, by its criticality (``low``, ``medium``,
    # ``high``), and the roles one of them must hold. One approval of anyone
    # who may approve unless set (``WORKPILOT_APPROVAL_QUORUM``,
    # ``WORKPILOT_APPROVAL_ROLES``).
    approval_quorum: tuple[tuple[str, int], ...]
    approval_roles: tuple[tuple[str, tuple[str, ...]], ...]
    # How long a card waits for its approvals before the second group of
    # approvers hears of it, per criticality (0: never), and who that group is:
    # the holders of these roles who may approve on the project
    # (``services/approval_escalation.py``). Off unless set.
    approval_escalation_hours: tuple[tuple[str, int], ...]
    approval_escalation_roles: tuple[str, ...]

    # Fernet key (urlsafe base64, 32 bytes) used to encrypt per-user
    # integration secrets (Azure PAT, Jira token) at rest.
    secrets_master_key: str

    # Directory where the server keeps its clones of registered repos.
    repos_root: Path

    # Maximum agent runs executing concurrently on this server.
    max_concurrent_runs: int

    # Public base URL used to build invitation links (e.g.
    # https://workpilot.example.com). Falls back to empty -> the API
    # returns a relative-looking link the admin can complete manually.
    public_base_url: str

    # Where the desktop app opens the board's live stream, when it is not
    # the API's host on port 8765 (a reverse proxy, TLS). ws:// or wss://
    # only; anything else is ignored.
    public_stream_url: str

    # The GitLab instances whose API the forge relay calls with a person's
    # token: gitlab.com and the hosts listed (comma-separated). A project
    # cloned from any other host shows no GitLab views.
    gitlab_hosts: tuple[str, ...]

    # The Sentry instances a « production incident » rule reads with a
    # person's token: sentry.io (and its regional hosts) and the self-hosted
    # hosts listed (comma-separated). A rule naming any other host fails.
    sentry_hosts: tuple[str, ...]

    # Notifications to the mobile app through Expo's push service
    # (exp.host), which hands them to Apple and Google. Off by default: the
    # server then sends nothing outside, and phones simply get no push.
    push_enabled: bool

    # "Needs you" on each person's own ntfy, Telegram or Teams
    # (services/needs_you.py): the server then posts to hosts the people
    # chose. Off by default, like push: nothing leaves the server.
    needs_you_enabled: bool

    # Self-service signup (invitation-only).
    invitation_ttl_hours: int
    password_min_length: int
    # Optional Have I Been Pwned k-anonymity check on new passwords.
    # Off by default so the server stays fully offline-capable.
    password_hibp_check: bool
    # How long a password reset link stays usable.
    password_reset_ttl_minutes: int
    # How long usage data is kept (tokens per run, presence days), in days.
    usage_retention_days: int

    # SMTP for transactional email (invitation links). All empty => email
    # disabled and the API returns the invite link for manual delivery.
    smtp_host: str
    smtp_port: int
    smtp_user: str
    smtp_password: str
    smtp_from: str
    smtp_use_tls: bool  # STARTTLS on a plaintext port (587)
    smtp_use_ssl: bool  # implicit TLS (465)

    @property
    def entra_enabled(self) -> bool:
        return bool(self.entra_tenant_id and self.entra_client_id)

    @property
    def oidc_enabled(self) -> bool:
        return bool(self.oidc_issuer and self.oidc_client_id)

    @property
    def escalation_enabled(self) -> bool:
        return any(hours for _, hours in self.approval_escalation_hours)

    @property
    def email_enabled(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)

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
            oidc_issuer=oidc_url(
                os.environ.get("WORKPILOT_OIDC_ISSUER", ""), issuer=True
            ),
            oidc_client_id=os.environ.get("WORKPILOT_OIDC_CLIENT_ID", "").strip(),
            oidc_name=_oidc_name(os.environ.get("WORKPILOT_OIDC_NAME", "")),
            oidc_scopes=_oidc_scopes(os.environ.get("WORKPILOT_OIDC_SCOPES", "")),
            self_approval=_self_approval(os.environ.get("WORKPILOT_SELF_APPROVAL", "")),
            approval_quorum=_approval_quorum(
                os.environ.get("WORKPILOT_APPROVAL_QUORUM", "")
            ),
            approval_roles=_approval_roles(
                os.environ.get("WORKPILOT_APPROVAL_ROLES", "")
            ),
            approval_escalation_hours=_escalation_hours(
                os.environ.get("WORKPILOT_APPROVAL_ESCALATION_HOURS", "")
            ),
            approval_escalation_roles=_escalation_roles(
                os.environ.get("WORKPILOT_APPROVAL_ESCALATION_ROLES", "")
            ),
            secrets_master_key=os.environ.get("WORKPILOT_SECRETS_MASTER_KEY", ""),
            repos_root=repos_root,
            max_concurrent_runs=_env_int("WORKPILOT_MAX_CONCURRENT_RUNS", 3),
            public_base_url=os.environ.get("WORKPILOT_PUBLIC_BASE_URL", "").rstrip("/"),
            public_stream_url=_stream_url(
                os.environ.get("WORKPILOT_PUBLIC_STREAM_URL", "")
            ),
            gitlab_hosts=_gitlab_hosts(os.environ.get("WORKPILOT_GITLAB_HOSTS", "")),
            sentry_hosts=_hosts(
                os.environ.get("WORKPILOT_SENTRY_HOSTS", ""),
                "sentry.io",
                "WORKPILOT_SENTRY_HOSTS",
            ),
            push_enabled=_env_bool("WORKPILOT_PUSH_ENABLED", False),
            needs_you_enabled=_env_bool("WORKPILOT_NEEDS_YOU_ENABLED", False),
            invitation_ttl_hours=_env_int("WORKPILOT_INVITATION_TTL_HOURS", 72),
            password_min_length=_env_int("WORKPILOT_PASSWORD_MIN_LENGTH", 12),
            password_hibp_check=_env_bool("WORKPILOT_PASSWORD_HIBP_CHECK", False),
            password_reset_ttl_minutes=_env_int(
                "WORKPILOT_PASSWORD_RESET_TTL_MINUTES", 60
            ),
            usage_retention_days=_env_int("WORKPILOT_USAGE_RETENTION_DAYS", 365),
            smtp_host=os.environ.get("WORKPILOT_SMTP_HOST", ""),
            smtp_port=_env_int("WORKPILOT_SMTP_PORT", 587),
            smtp_user=os.environ.get("WORKPILOT_SMTP_USER", ""),
            smtp_password=os.environ.get("WORKPILOT_SMTP_PASSWORD", ""),
            smtp_from=os.environ.get("WORKPILOT_SMTP_FROM", ""),
            smtp_use_tls=_env_bool("WORKPILOT_SMTP_USE_TLS", True),
            smtp_use_ssl=_env_bool("WORKPILOT_SMTP_USE_SSL", False),
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
