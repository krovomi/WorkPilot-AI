"""A person's own "needs you" channels on the server (ntfy, Telegram, Teams).

``GET /users/me/needs-you`` says what is set, never a secret's value (a mask
in its place). ``PUT /users/me/needs-you/channels/{channel}`` stores one, a
secret left out or sent as the mask keeps the stored one;
``DELETE`` removes it; ``POST .../test`` sends the test message from what is
stored. ``PUT /users/me/needs-you/preferences`` picks the moments and the
language. A person only ever touches their own rows.

Permissions: reading and removing one's own settings needs ``task.read``
(any member). Storing a destination, or sending a test, makes the server post
to a host the person chose: that needs ``agent.execute``, the right whose runs
the notifications are about.
"""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from server.auth.deps import CurrentUser, get_current_user
from server.authz.deps import require_permission
from server.config import get_settings
from server.db.engine import get_db
from server.services import needs_you
from server.services.needs_you_send import CHANNELS, REJECTIONS, ChannelRejected
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users/me/needs-you", tags=["users"])

_READ = [Depends(require_permission("task.read"))]
_WRITE = [Depends(require_permission("agent.execute"))]

Channel = Literal["ntfy", "telegram", "teams"]


class ChannelSettings(BaseModel):
    enabled: bool = True
    # ntfy
    server: str | None = Field(default=None, max_length=2048)
    topic: str | None = Field(default=None, max_length=64)
    access_token: str | None = Field(default=None, max_length=256)
    # Telegram
    bot_token: str | None = Field(default=None, max_length=128)
    chat_id: str | None = Field(default=None, max_length=24)
    # Teams
    webhook_url: str | None = Field(default=None, max_length=2048)


class Preferences(BaseModel):
    events: dict[str, bool] = Field(default_factory=dict)
    locale: str = Field(default="en", max_length=8)


def _known(channel: str) -> str:
    if channel not in CHANNELS:
        raise HTTPException(status_code=404, detail="Unknown channel")
    return channel


@router.get("", dependencies=_READ)
async def my_needs_you(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await needs_you.overview(db, user.id)


@router.put("/channels/{channel}", dependencies=_WRITE)
async def save_my_channel(
    channel: Channel,
    body: ChannelSettings,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    try:
        await needs_you.save_channel(db, user.id, channel, body.model_dump())
    except needs_you.VaultUnavailable:
        raise HTTPException(
            status_code=409,
            detail="The server has no secrets master key: channels cannot be stored",
        ) from None
    except ChannelRejected as e:
        # The literal from the table, never text derived from the input.
        raise HTTPException(
            status_code=400, detail=REJECTIONS.get(e.reason, "Invalid settings")
        ) from None
    return {"saved": True}


@router.delete("/channels/{channel}", dependencies=_READ)
async def delete_my_channel(
    channel: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return {"deleted": await needs_you.delete_channel(db, user.id, _known(channel))}


@router.post("/channels/{channel}/test", dependencies=_WRITE)
async def test_my_channel(
    channel: str,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    _known(channel)
    if not get_settings().needs_you_enabled:
        # Off, nothing leaves the server, a test included.
        raise HTTPException(status_code=409, detail="Turned off on this server")
    if not needs_you.test_allowed(user.id, channel):
        raise HTTPException(status_code=429, detail="Wait a few seconds")
    result = await needs_you.send_test(db, user.id, channel)
    if result is None:
        raise HTTPException(status_code=404, detail="Channel not set")
    return {"result": result}


@router.put("/preferences", dependencies=_READ)
async def save_my_preferences(
    body: Preferences,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    unknown = set(body.events) - set(needs_you.EVENTS)
    if unknown:
        raise HTTPException(status_code=400, detail="Unknown moment")
    await needs_you.save_preferences(db, user.id, body.events, body.locale)
    return {"saved": True}
