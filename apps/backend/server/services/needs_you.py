""" "Needs you" from the server: a card waits for its person, on their channels.

The desktop announces these moments from its state machine
(``docs/architecture/needs-you.md``); a server card has no desktop watching
it, so the run manager calls :func:`notify_needs_you` when a run ends and the
person who started it is told on the channels they set up for themselves:
ntfy, Telegram or a Teams webhook (``needs_you_send.py``).

| Run that ended                         | Moment         |
|----------------------------------------|----------------|
| spec, succeeded, plan not yet approved | ``plan_review`` |
| spec on a card without review, build, qa, succeeded | ``review_ready`` |
| any phase, failed                      | ``failed``      |
| cancelled, merge or pr succeeded       | nothing         |

What leaves is what push sends (``push.py``): the project's name and the
card's number, never the card's title, text or error. Each person's
destinations are secrets: stored Fernet-encrypted with the server's master
key (``secrets.py``), never returned by a route (only that they are set),
never logged. Sending runs in the background, is off unless the operator
turns it on (``WORKPILOT_NEEDS_YOU_ENABLED``), and never fails a run.

Whether a plan still waits for approval is the board's answer
(``review.state``): the server imports no feature unit, so the board installs
it with :func:`set_approval_check`, as it does for push.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from collections.abc import Callable
from pathlib import Path

import httpx
from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import NeedsYouChannel, NeedsYouPreference, Project
from server.services import needs_you_send as channels
from server.services.secrets import SecretsVaultError, decrypt_value, encrypt_value
from sqlalchemy import select
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

EVENTS: tuple[str, ...] = ("plan_review", "review_ready", "failed")
LOCALES = frozenset({"en", "fr"})
#: What a route shows in place of a stored secret: that it is set, nothing of it.
MASK = "********"
#: The secrets of each channel; everything else in its settings is not one.
SECRET_FIELDS: dict[str, tuple[str, ...]] = {
    "ntfy": ("topic", "access_token"),
    "telegram": ("bot_token",),
    "teams": ("webhook_url",),
}
#: A person can send themselves one test per channel this often.
TEST_COOLDOWN_SECONDS = 10.0
_CARD_NUMBER = re.compile(r"^(\d{3,4})-")

_STRINGS: dict[str, dict[str, tuple[str, str]]] = {
    "en": {
        "plan_review": (
            "Plan waiting for you",
            "{project}, card {card}: the plan is ready. Coding starts once it is approved.",
        ),
        "review_ready": (
            "Ready for review",
            "{project}, card {card} is done and waiting for your review.",
        ),
        "failed": (
            "Task stopped on an error",
            "{project}, card {card} stopped on an error.",
        ),
        "test": ("WorkPilot test", "Notifications from the server reach you here."),
    },
    "fr": {
        "plan_review": (
            "Un plan t'attend",
            "{project}, carte {card} : le plan est prêt. Le code démarre dès qu'il est approuvé.",
        ),
        "review_ready": (
            "Prête pour ta revue",
            "{project}, carte {card} : terminée, elle attend ta revue.",
        ),
        "failed": (
            "Tâche arrêtée sur une erreur",
            "{project}, carte {card} : arrêtée sur une erreur.",
        ),
        "test": ("Test WorkPilot", "Les notifications du serveur t'arrivent bien ici."),
    },
}

_background: set[asyncio.Task] = set()
_approval_pending: Callable[[Path], bool] | None = None
_last_test: dict[tuple[str, str], float] = {}


class VaultUnavailable(RuntimeError):
    """No master key: a destination cannot be stored, and is not, in clear."""


# ── Which moment a run's end is ────────────────────────────────────────────


def set_approval_check(check: Callable[[Path], bool] | None) -> None:
    """Install how to tell a plan not yet approved, given its spec folder."""
    global _approval_pending
    _approval_pending = check


def _card_directory(server_path: str, card_id: str) -> Path | None:
    specs = (Path(server_path) / ".workpilot" / "specs").resolve()
    directory = (specs / card_id).resolve()
    if directory.parent != specs or not (directory / "spec.md").is_file():
        return None
    return directory


def _asks_for_review(directory: Path) -> bool:
    try:
        metadata = json.loads(
            (directory / "task_metadata.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return True
    return not (
        isinstance(metadata, dict)
        and metadata.get("requireReviewBeforeCoding") is False
    )


def classify(
    phase: str, status: str, server_path: str | None, card_id: str
) -> str | None:
    """The moment a run's end is for its person, or None."""
    if status == "failed":
        return "failed"
    if status != "succeeded":
        return None
    if phase in {"build", "qa"}:
        return "review_ready"
    if phase != "spec" or not server_path:
        return None
    directory = _card_directory(server_path, card_id)
    if directory is None:
        return None
    if not _asks_for_review(directory):
        # The spec runner went on to the build (``--auto-approve``).
        return "review_ready"
    try:
        pending = _approval_pending is not None and _approval_pending(directory)
    except (OSError, ValueError):
        pending = False
    return "plan_review" if pending else None


def message(
    event: str, locale: str, project_name: str, card_id: str
) -> channels.Message:
    strings = _STRINGS[locale if locale in LOCALES else "en"]
    title, body = strings[event]
    match = _CARD_NUMBER.match(card_id)
    card = match.group(1) if match else card_id[:12]
    return channels.Message(
        title=title, body=body.format(project=project_name[:80], card=card)
    )


# ── A person's settings ────────────────────────────────────────────────────


def vault_ready() -> bool:
    return bool(get_settings().secrets_master_key)


def _secrets_of(row: NeedsYouChannel) -> dict:
    value = json.loads(decrypt_value(row.encrypted_secrets))
    return value if isinstance(value, dict) else {}


def _settings_of(row: NeedsYouChannel) -> dict:
    try:
        value = json.loads(row.settings or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}


async def _preferences(db: AsyncSession, user_id: str) -> tuple[set[str], str]:
    row = await db.get(NeedsYouPreference, user_id)
    if row is None:
        return set(), "en"
    try:
        muted = set(json.loads(row.muted_events or "[]")) & set(EVENTS)
    except (ValueError, TypeError):
        muted = set()
    return muted, row.locale if row.locale in LOCALES else "en"


def _shown(channel: str, row: NeedsYouChannel) -> dict:
    """A channel as a route shows it: its secrets only as set or not."""
    settings = _settings_of(row)
    shown: dict = {"configured": True, "enabled": row.enabled}
    try:
        secrets = _secrets_of(row)
        readable = True
    except (SecretsVaultError, ValueError):
        secrets, readable = {}, False
    shown["readable"] = readable
    for field in SECRET_FIELDS[channel]:
        shown[field] = MASK if secrets.get(field) or not readable else None
    if channel == "ntfy":
        shown["server"] = settings.get("server") or channels.PUBLIC_NTFY
    elif channel == "telegram":
        shown["chat_id"] = settings.get("chat_id") or ""
    return shown


async def overview(db: AsyncSession, user_id: str) -> dict:
    muted, locale = await _preferences(db, user_id)
    rows = {
        row.channel: row
        for row in await db.scalars(
            select(NeedsYouChannel).where(NeedsYouChannel.user_id == user_id)
        )
    }
    return {
        "available": get_settings().needs_you_enabled,
        "vault": vault_ready(),
        "locale": locale,
        "events": {event: event not in muted for event in EVENTS},
        "channels": {
            channel: _shown(channel, rows[channel])
            if channel in rows
            else {"configured": False}
            for channel in channels.CHANNELS
        },
    }


def _incoming(value: object) -> str | None:
    """A secret field as sent: None (or the mask) keeps what is stored."""
    if value is None or value == MASK:
        return None
    return value.strip() if isinstance(value, str) else ""


async def save_channel(
    db: AsyncSession, user_id: str, channel: str, fields: dict
) -> None:
    """Validate and store one channel. Raises ChannelRejected or VaultUnavailable."""
    if channel not in SECRET_FIELDS:
        raise channels.ChannelRejected("url")
    if not vault_ready():
        raise VaultUnavailable
    row = await db.scalar(
        select(NeedsYouChannel).where(
            NeedsYouChannel.user_id == user_id, NeedsYouChannel.channel == channel
        )
    )
    stored: dict = {}
    if row is not None:
        try:
            stored = _secrets_of(row)
        except (SecretsVaultError, ValueError):
            stored = {}
    secrets = dict(stored)
    for field in SECRET_FIELDS[channel]:
        incoming = _incoming(fields.get(field))
        if incoming is not None:
            secrets[field] = incoming
    settings: dict
    if channel == "ntfy":
        server = channels.validate_ntfy(fields.get("server"), secrets.get("topic"))
        if secrets.get("access_token") and not re.fullmatch(
            r"[A-Za-z0-9_.-]{1,256}", secrets["access_token"]
        ):
            raise channels.ChannelRejected("access_token")
        settings = {"server": server}
    elif channel == "telegram":
        chat_id = channels.validate_telegram(
            secrets.get("bot_token"), fields.get("chat_id")
        )
        settings = {"chat_id": chat_id}
    else:
        secrets["webhook_url"] = channels.validate_teams(secrets.get("webhook_url"))
        settings = {}
    secrets = {k: v for k, v in secrets.items() if v}
    try:
        encrypted = encrypt_value(json.dumps(secrets))
    except SecretsVaultError:
        raise VaultUnavailable from None
    if row is None:
        row = NeedsYouChannel(user_id=user_id, channel=channel)
        db.add(row)
    row.enabled = bool(fields.get("enabled", True))
    row.settings = json.dumps(settings)
    row.encrypted_secrets = encrypted
    await db.commit()


async def delete_channel(db: AsyncSession, user_id: str, channel: str) -> bool:
    row = await db.scalar(
        select(NeedsYouChannel).where(
            NeedsYouChannel.user_id == user_id, NeedsYouChannel.channel == channel
        )
    )
    if row is None:
        return False
    await db.delete(row)
    await db.commit()
    return True


async def save_preferences(
    db: AsyncSession, user_id: str, events: dict[str, bool], locale: str
) -> None:
    row = await db.get(NeedsYouPreference, user_id)
    if row is None:
        row = NeedsYouPreference(user_id=user_id)
        db.add(row)
    row.muted_events = json.dumps(
        sorted(e for e in EVENTS if events.get(e, True) is False)
    )
    row.locale = locale if locale in LOCALES else "en"
    await db.commit()


# ── Sending ────────────────────────────────────────────────────────────────


async def _send_all(
    rows: list[NeedsYouChannel],
    text: channels.Message,
    client: httpx.AsyncClient | None = None,
    resolver: channels.Resolver = channels.system_resolver,
) -> dict[str, str]:
    results: dict[str, str] = {}
    owned = client is None
    client = client or httpx.AsyncClient(timeout=channels.TIMEOUT_SECONDS)
    try:
        for row in rows:
            try:
                secrets = _secrets_of(row)
            except (SecretsVaultError, ValueError):
                logger.warning(
                    "Needs-you %s not sent: unreadable settings", row.channel
                )
                results[row.channel] = "blocked"
                continue
            results[row.channel] = await channels.deliver(
                row.channel,
                _settings_of(row),
                secrets,
                text,
                client=client,
                resolver=resolver,
            )
    finally:
        if owned:
            await client.aclose()
    return results


def test_allowed(user_id: str, channel: str) -> bool:
    """One test per person and channel every :data:`TEST_COOLDOWN_SECONDS`."""
    now = time.monotonic()
    last = _last_test.get((user_id, channel))
    if last is not None and now - last < TEST_COOLDOWN_SECONDS:
        return False
    _last_test[(user_id, channel)] = now
    return True


async def send_test(
    db: AsyncSession,
    user_id: str,
    channel: str,
    client: httpx.AsyncClient | None = None,
    resolver: channels.Resolver = channels.system_resolver,
) -> str | None:
    """Send the test message on a stored channel; None when it is not set."""
    row = await db.scalar(
        select(NeedsYouChannel).where(
            NeedsYouChannel.user_id == user_id, NeedsYouChannel.channel == channel
        )
    )
    if row is None:
        return None
    _, locale = await _preferences(db, user_id)
    title, body = _STRINGS[locale]["test"]
    results = await _send_all(
        [row], channels.Message(title=title, body=body), client, resolver
    )
    return results[channel]


async def _notify(
    project_id: str, card_id: str, phase: str, status: str, user_id: str
) -> None:
    async with get_session_factory()() as db:
        rows = list(
            await db.scalars(
                select(NeedsYouChannel).where(
                    NeedsYouChannel.user_id == user_id,
                    NeedsYouChannel.enabled.is_(True),
                )
            )
        )
        if not rows:
            return
        project = await db.get(Project, project_id)
        event = classify(
            phase, status, project.server_path if project else None, card_id
        )
        if event is None:
            return
        muted, locale = await _preferences(db, user_id)
        if event in muted:
            return
        name = project.name if project else "WorkPilot"
    await _send_all(rows, message(event, locale, name, card_id))


def notify_needs_you(
    project_id: str, card_id: str, phase: str, status: str, user_id: str | None
) -> None:
    """Tell the person who started the run, in the background, if it is on."""
    if not user_id or status not in {"succeeded", "failed"}:
        return
    if not get_settings().needs_you_enabled:
        return

    async def run() -> None:
        try:
            await _notify(project_id, card_id, phase, status, user_id)
        # Never fail a run over a notification. The type only: a message
        # could carry a destination.
        except (
            httpx.HTTPError,
            SQLAlchemyError,
            SecretsVaultError,
            ValueError,
            OSError,
        ) as e:
            logger.warning("Needs-you notification not sent: %s", type(e).__name__)

    try:
        task = asyncio.get_running_loop().create_task(run())
    except RuntimeError:
        return
    _background.add(task)
    task.add_done_callback(_background.discard)
