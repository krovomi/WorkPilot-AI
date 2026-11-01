"""Notifications to the mobile app: a run of yours finished.

The phone registers the Expo push token it obtained (``routers/devices.py``);
when a run ends, the person who started it gets one notification per phone
(``notify_run_finished``, called by the run manager). Expo's push service
hands it to Apple (APNs) or Google (FCM), which is why it is off unless the
operator turns it on (``WORKPILOT_PUSH_ENABLED``): it is the only thing here
that leaves the server.

What leaves is the least that makes the notification useful: the project's
name, the card's number, the phase and its result. Never the card's title or
text, which are the team's and would otherwise sit in three vendors' logs.
The phone opens the card from ``data`` (``projectId``, ``cardId``).

A token Expo reports as no longer registered (the app was removed, the
person signed out on a phone that was offline) is deleted. Sending never
blocks or fails a run: it runs in the background and only logs.
"""

from __future__ import annotations

import asyncio
import logging
import re
from datetime import UTC, datetime

import httpx
from server.config import get_settings
from server.db.engine import get_session_factory
from server.db.models import Project, PushDevice
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send"
#: An Expo push token, as the app gets it from expo-notifications.
TOKEN = re.compile(r"^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,160}\]$")
PLATFORMS = frozenset({"ios", "android"})
LOCALES = frozenset({"en", "fr"})
#: The most phones one person keeps registered; the oldest go first.
MAX_DEVICES_PER_USER = 10
#: A card's number: the digits before its name.
_CARD_NUMBER = re.compile(r"^(\d{3,4})-")

_PHASES = {
    "en": {
        "spec": "Spec",
        "build": "Build",
        "qa": "QA",
        "merge": "Merge",
        "pr": "Pull request",
    },
    "fr": {
        "spec": "Spec",
        "build": "Build",
        "qa": "QA",
        "merge": "Fusion",
        "pr": "Pull request",
    },
}
_BODIES = {
    "en": {
        "succeeded": "{phase} finished on card {card}",
        "failed": "{phase} failed on card {card}",
    },
    "fr": {
        "succeeded": "{phase} terminé sur la carte {card}",
        "failed": "{phase} en échec sur la carte {card}",
    },
}

_background: set[asyncio.Task] = set()


def valid_token(token: object) -> bool:
    return isinstance(token, str) and bool(TOKEN.match(token))


async def register_device(
    db: AsyncSession, user_id: str, token: str, platform: str, locale: str
) -> PushDevice:
    """Register (or move to this person) a phone's token."""
    now = datetime.now(UTC)
    device = await db.scalar(select(PushDevice).where(PushDevice.token == token))
    if device is None:
        device = PushDevice(token=token, user_id=user_id, created_at=now)
        db.add(device)
    device.user_id = user_id
    device.platform = platform
    device.locale = locale if locale in LOCALES else "en"
    device.last_seen_at = now
    await db.flush()
    # Keep a bounded list: a person who reinstalls often does not pile up tokens.
    stale = list(
        await db.scalars(
            select(PushDevice.id)
            .where(PushDevice.user_id == user_id)
            .order_by(PushDevice.last_seen_at.desc())
            .offset(MAX_DEVICES_PER_USER)
        )
    )
    if stale:
        await db.execute(delete(PushDevice).where(PushDevice.id.in_(stale)))
    await db.commit()
    return device


async def unregister_device(db: AsyncSession, user_id: str, token: str) -> bool:
    """Forget a phone's token; only its owner can."""
    result = await db.execute(
        delete(PushDevice).where(
            PushDevice.token == token, PushDevice.user_id == user_id
        )
    )
    await db.commit()
    return bool(result.rowcount)


def build_messages(
    devices: list[PushDevice],
    project_id: str,
    project_name: str,
    card_id: str,
    phase: str,
    status: str,
) -> list[dict]:
    """One message per phone, in its language; nothing for another status."""
    match = _CARD_NUMBER.match(card_id)
    card = match.group(1) if match else card_id[:12]
    messages = []
    for device in devices:
        locale = device.locale if device.locale in LOCALES else "en"
        template = _BODIES[locale].get(status)
        if template is None:
            continue
        label = _PHASES[locale].get(phase, phase)
        messages.append(
            {
                "to": device.token,
                "title": project_name[:80],
                "body": template.format(phase=label, card=card),
                "sound": "default",
                "data": {
                    "type": "run_finished",
                    "projectId": project_id,
                    "cardId": card_id,
                    "phase": phase,
                    "status": status,
                },
            }
        )
    return messages


async def send(
    messages: list[dict], client: httpx.AsyncClient | None = None
) -> list[str]:
    """Hand the messages to Expo; return the tokens it says are gone."""
    if not messages:
        return []
    owned = client is None
    client = client or httpx.AsyncClient(timeout=15)
    try:
        response = await client.post(
            EXPO_PUSH_URL,
            json=messages,
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        tickets = response.json().get("data") or []
    finally:
        if owned:
            await client.aclose()
    gone = []
    for message, ticket in zip(messages, tickets, strict=False):
        details = ticket.get("details") if isinstance(ticket, dict) else None
        if (
            isinstance(ticket, dict)
            and ticket.get("status") == "error"
            and isinstance(details, dict)
            and details.get("error") == "DeviceNotRegistered"
        ):
            gone.append(message["to"])
    return gone


async def _notify(
    project_id: str, card_id: str, phase: str, status: str, user_id: str
) -> None:
    async with get_session_factory()() as db:
        devices = list(
            await db.scalars(select(PushDevice).where(PushDevice.user_id == user_id))
        )
        if not devices:
            return
        project = await db.get(Project, project_id)
        name = project.name if project else "WorkPilot"
        messages = build_messages(devices, project_id, name, card_id, phase, status)
        gone = await send(messages)
        if gone:
            await db.execute(delete(PushDevice).where(PushDevice.token.in_(gone)))
            await db.commit()


def notify_run_finished(
    project_id: str, card_id: str, phase: str, status: str, user_id: str | None
) -> None:
    """Tell the person who started the run, in the background, if push is on."""
    if not user_id or status not in {"succeeded", "failed"}:
        return
    if not get_settings().push_enabled:
        return

    async def run() -> None:
        try:
            await _notify(project_id, card_id, phase, status, user_id)
        except Exception as e:  # never fail a run over a notification
            logger.warning("Push notification not sent: %s", type(e).__name__)

    try:
        task = asyncio.get_running_loop().create_task(run())
    except RuntimeError:
        return
    _background.add(task)
    task.add_done_callback(_background.discard)
