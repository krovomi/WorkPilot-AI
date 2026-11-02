"""A person's interface preferences (``/users/me/preferences``).

``GET`` returns the theme the person last chose on any device (``null``
values when they never chose one), ``PUT`` replaces it. The route names no
user: a person reads and writes only their own row, so being signed in is
the whole permission, as for ``/users/me/devices`` and ``/users/me/secrets``.
Anything outside the closed lists is refused with 422.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from server.auth.deps import CurrentUser, get_current_user
from server.db.engine import get_db
from server.services.preferences import (
    ColorTheme,
    ThemeMode,
    get_preferences,
    set_preferences,
)
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users/me/preferences", tags=["users"])


class Preferences(BaseModel):
    """As the desktop's settings name them: ``theme`` and ``colorTheme``."""

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=False)

    theme: ThemeMode
    color_theme: ColorTheme = Field(alias="colorTheme")


class StoredPreferences(BaseModel):
    theme: ThemeMode | None
    colorTheme: ColorTheme | None  # noqa: N815 - the wire name the clients use


@router.get("", response_model=StoredPreferences)
async def read(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StoredPreferences:
    row = await get_preferences(db, user.id)
    if row is None:
        return StoredPreferences(theme=None, colorTheme=None)
    return StoredPreferences(theme=row.theme, colorTheme=row.color_theme)


@router.put("", response_model=StoredPreferences)
async def write(
    body: Preferences,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StoredPreferences:
    row = await set_preferences(db, user.id, body.theme, body.color_theme)
    return StoredPreferences(theme=row.theme, colorTheme=row.color_theme)
