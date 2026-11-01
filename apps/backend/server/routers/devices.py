"""The phones that receive a person's notifications (the mobile app).

``PUT /users/me/devices`` registers the Expo push token the app obtained,
``DELETE`` forgets it (sign-out). A person only ever touches their own
devices: the token names a phone, and registering it under another account
moves it there, as one phone has one signed-in person.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from server.auth.deps import CurrentUser, get_current_user
from server.db.engine import get_db
from server.services.push import (
    PLATFORMS,
    register_device,
    unregister_device,
    valid_token,
)
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users/me/devices", tags=["users"])


class DeviceRegistration(BaseModel):
    token: str = Field(max_length=200)
    platform: str = Field(max_length=10)
    locale: str = Field(default="en", max_length=8)


class DeviceRemoval(BaseModel):
    token: str = Field(max_length=200)


@router.put("")
async def register(
    body: DeviceRegistration,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    if not valid_token(body.token):
        raise HTTPException(status_code=400, detail="Invalid push token")
    if body.platform not in PLATFORMS:
        raise HTTPException(status_code=400, detail="Unknown platform")
    await register_device(db, user.id, body.token, body.platform, body.locale)
    return {"registered": True}


@router.delete("")
async def remove(
    body: DeviceRemoval,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return {"removed": await unregister_device(db, user.id, body.token)}
