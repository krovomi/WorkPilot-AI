"""A person's AI accounts on a shared server, and the keys their runs get.

The desktop keeps several accounts per provider on the machine
(``apps/frontend/src/main/ai-accounts/``). On a server, the same idea is per
member: each person saves their own keys (their own OpenAI key, their
employer's, a client's), marks one per provider as the default, and every run
or job they start receives that key in its environment
(``run_manager._build_env``). A provider without a default keeps what the
operator set for the deployment.

The key is encrypted at rest with the vault of ``services/secrets.py`` and is
never read back by a route: a view says only that it is set, and when.
An account belongs to one person; another person's id answers as unknown.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from types import MappingProxyType

from server.db.models import UserAiAccount
from server.services.secrets import decrypt_value, encrypt_value
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

#: Provider → the environment variables its key goes to in a run. The names
#: are the ones the backend's clients read (``core/agent_clients/``,
#: ``gateway_providers.py``); ``claude`` is a long-lived Claude Code token
#: (``claude setup-token``), read first by ``core.auth``.
PROVIDER_ENV: MappingProxyType[str, tuple[str, ...]] = MappingProxyType(
    {
        "claude": ("CLAUDE_CODE_OAUTH_TOKEN",),
        "openai": ("OPENAI_API_KEY",),
        "google": ("GOOGLE_API_KEY",),
        "mistral": ("MISTRAL_API_KEY",),
        "deepseek": ("DEEPSEEK_API_KEY",),
        "grok": ("GROK_API_KEY",),
        "meta": ("META_API_KEY",),
        "openrouter": ("OPENROUTER_API_KEY",),
        "huggingface": ("HUGGINGFACE_API_KEY", "HF_TOKEN"),
    }
)

PROVIDERS: tuple[str, ...] = tuple(PROVIDER_ENV)

#: Every variable an account may set in a run (``run_env``'s guard test).
ACCOUNT_ENV: frozenset[str] = frozenset(
    name for names in PROVIDER_ENV.values() for name in names
)

MAX_NAME_LENGTH = 80
MAX_KEY_LENGTH = 4096
#: Accounts one person may keep, all providers together.
MAX_ACCOUNTS = 50


class AiAccountError(ValueError):
    """A request the store refuses; the message is safe to show."""


class UnknownAccount(LookupError):
    """No account of this id for this person."""


@dataclass(frozen=True)
class AccountView:
    """What a route answers about an account: never the key."""

    id: str
    provider: str
    name: str
    is_default: bool
    has_key: bool
    created_at: datetime
    key_set_at: datetime

    def payload(self) -> dict:
        return {
            "id": self.id,
            "provider": self.provider,
            "name": self.name,
            "is_default": self.is_default,
            "has_key": self.has_key,
            "created_at": self.created_at,
            "key_set_at": self.key_set_at,
        }


def _utc(value: datetime) -> datetime:
    """SQLite gives back naive datetimes: they were written in UTC."""
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _view(row: UserAiAccount) -> AccountView:
    return AccountView(
        id=row.id,
        provider=row.provider,
        name=row.name,
        is_default=bool(row.is_default),
        has_key=bool(row.encrypted_key),
        created_at=_utc(row.created_at),
        key_set_at=_utc(row.key_set_at),
    )


def clean_provider(provider: object) -> str:
    value = provider.strip().lower() if isinstance(provider, str) else ""
    if value not in PROVIDER_ENV:
        raise AiAccountError(f"Unknown provider. Allowed: {list(PROVIDERS)}")
    return value


def clean_name(name: object) -> str:
    value = " ".join(name.split()) if isinstance(name, str) else ""
    if not value or len(value) > MAX_NAME_LENGTH:
        raise AiAccountError(f"A name of 1 to {MAX_NAME_LENGTH} characters")
    return value


def clean_key(key: object) -> str:
    value = key.strip() if isinstance(key, str) else ""
    if not value or len(value) > MAX_KEY_LENGTH or any(c.isspace() for c in value):
        raise AiAccountError("Invalid key")
    return value


async def _rows(db: AsyncSession, user_id: str) -> list[UserAiAccount]:
    found = await db.scalars(
        select(UserAiAccount)
        .where(UserAiAccount.user_id == user_id)
        .order_by(UserAiAccount.provider, UserAiAccount.created_at, UserAiAccount.id)
    )
    return list(found)


async def _owned(db: AsyncSession, user_id: str, account_id: str) -> UserAiAccount:
    row = await db.get(UserAiAccount, account_id)
    if row is None or row.user_id != user_id:
        raise UnknownAccount(account_id)
    return row


async def list_accounts(db: AsyncSession, user_id: str) -> list[AccountView]:
    return [_view(row) for row in await _rows(db, user_id)]


def defaults_of(accounts: list[AccountView]) -> dict[str, str]:
    """Provider → id of its default account."""
    return {a.provider: a.id for a in accounts if a.is_default}


async def create_account(
    db: AsyncSession, user_id: str, provider: object, name: object, key: object
) -> AccountView:
    """Save a new account; the first of its provider becomes the default."""
    provider = clean_provider(provider)
    name = clean_name(name)
    key = clean_key(key)
    rows = await _rows(db, user_id)
    if len(rows) >= MAX_ACCOUNTS:
        raise AiAccountError(f"At most {MAX_ACCOUNTS} accounts per person")
    now = datetime.now(UTC)
    row = UserAiAccount(
        user_id=user_id,
        provider=provider,
        name=name,
        encrypted_key=encrypt_value(key),
        is_default=not any(r.provider == provider for r in rows),
        created_at=now,
        key_set_at=now,
    )
    db.add(row)
    await db.commit()
    return _view(row)


async def update_account(
    db: AsyncSession,
    user_id: str,
    account_id: str,
    *,
    name: object = None,
    key: object = None,
) -> AccountView:
    """Rename an account, replace its key, or both; ``None`` keeps a field."""
    row = await _owned(db, user_id, account_id)
    new_name = None if name is None else clean_name(name)
    new_key = None if key is None else clean_key(key)
    if new_name is not None:
        row.name = new_name
    if new_key is not None:
        row.encrypted_key = encrypt_value(new_key)
        row.key_set_at = datetime.now(UTC)
    await db.commit()
    return _view(row)


async def delete_account(
    db: AsyncSession, user_id: str, account_id: str
) -> AccountView:
    """Delete an account. When it was the default, the provider goes back to
    the deployment's own credentials: no other account is promoted behind the
    person's back."""
    row = await _owned(db, user_id, account_id)
    view = _view(row)
    await db.delete(row)
    await db.commit()
    return view


async def set_default(
    db: AsyncSession, user_id: str, provider: object, account_id: str | None
) -> str | None:
    """Make ``account_id`` the default of ``provider``, or none (``None``)."""
    provider = clean_provider(provider)
    chosen = None
    if account_id is not None:
        chosen = await _owned(db, user_id, account_id)
        if chosen.provider != provider:
            raise AiAccountError("This account belongs to another provider")
    for row in await _rows(db, user_id):
        if row.provider == provider:
            row.is_default = chosen is not None and row.id == chosen.id
    await db.commit()
    return chosen.id if chosen is not None else None


async def run_env(db: AsyncSession, user_id: str) -> dict[str, str]:
    """The variables a run of ``user_id`` gets from their default accounts.

    Raises ``SecretsVaultError`` when a key cannot be decrypted (the master
    key changed); the caller decides what a run does without it.
    """
    env: dict[str, str] = {}
    for row in await _rows(db, user_id):
        if not row.is_default or row.provider not in PROVIDER_ENV:
            continue
        key = decrypt_value(row.encrypted_key)
        for name in PROVIDER_ENV[row.provider]:
            env[name] = key
    return env
