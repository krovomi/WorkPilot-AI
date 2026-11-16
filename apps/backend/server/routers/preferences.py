"""A person's interface preferences (``/users/me/preferences``).

``GET`` returns the theme the person last chose on any device (``null``
values when they never chose one), ``PUT`` replaces it. ``/menu`` does the
same for the desktop's left menu as the person arranged it (``layout`` is
``null`` until they save one). The routes name no user: a person reads and
writes only their own rows, so being signed in is the whole permission, as
for ``/users/me/devices`` and ``/users/me/secrets``. Anything outside the
closed lists, an id that is not a menu id or a list over its bound is
refused with 422.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from server.auth.deps import CurrentUser, get_current_user
from server.db.engine import get_db
from server.services.preferences import (
    ColorTheme,
    MenuLayout,
    ThemeMode,
    get_menu_layout,
    get_preferences,
    set_menu_layout,
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


def _menu(layout: MenuLayout | None) -> dict:
    return {"layout": None if layout is None else layout.model_dump(by_alias=True)}


@router.get("/menu")
async def read_menu(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return _menu(await get_menu_layout(db, user.id))


@router.put("/menu")
async def write_menu(
    body: MenuLayout,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return _menu(await set_menu_layout(db, user.id, body))
