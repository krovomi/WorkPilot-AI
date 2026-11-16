"""A person's interface preferences, stored once for all their devices.

The desktop and the phone read them at sign-in and write them when the
person changes their theme. Only closed lists are accepted: the mode of the
desktop's settings (``AppSettings.theme``) and the ids of its colour themes
(``apps/frontend/src/shared/constants/themes.ts``).

The desktop's menu, as the person arranged it, is kept the same way
(``MenuLayout``): only menu ids (lower-case letters, digits and dashes) in
bounded lists cross, as ``apps/frontend/src/shared/utils/menu-layout.ts``
checks them on the desktop.
"""

from __future__ import annotations

from typing import Annotated, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from server.db.models import UserMenuLayout, UserPreference
from sqlalchemy.ext.asyncio import AsyncSession

ThemeMode = Literal["light", "dark", "system"]
ColorTheme = Literal["default", "dusk", "lime", "ocean", "retro", "neo", "forest"]

THEME_MODES: frozenset[str] = frozenset(get_args(ThemeMode))
COLOR_THEMES: frozenset[str] = frozenset(get_args(ColorTheme))


async def get_preferences(db: AsyncSession, user_id: str) -> UserPreference | None:
    return await db.get(UserPreference, user_id)


async def set_preferences(
    db: AsyncSession, user_id: str, theme: str, color_theme: str
) -> UserPreference:
    """Create or replace the person's row; values are checked by the caller's schema."""
    if theme not in THEME_MODES or color_theme not in COLOR_THEMES:
        raise ValueError("Unknown theme")
    row = await db.get(UserPreference, user_id)
    if row is None:
        row = UserPreference(user_id=user_id, theme=theme, color_theme=color_theme)
        db.add(row)
    else:
        row.theme = theme
        row.color_theme = color_theme
    await db.commit()
    return row


#: A page, hub or group id of the desktop's menu (``nav-model.ts``, ``hubs.ts``).
MenuId = Annotated[str, StringConstraints(pattern=r"^[a-z0-9][a-z0-9-]{0,63}$")]
#: Bounds well above the menu's size (about 80 pages in 10 groups).
MAX_MENU_GROUPS = 64
MAX_MENU_ENTRIES = 300


class MenuLayout(BaseModel):
    """The menu as the person arranged it, under the desktop's field names."""

    model_config = ConfigDict(extra="forbid", strict=True, populate_by_name=False)

    group_order: list[MenuId] = Field(alias="groupOrder", max_length=MAX_MENU_GROUPS)
    item_order: dict[
        MenuId, Annotated[list[MenuId], Field(max_length=MAX_MENU_ENTRIES)]
    ] = Field(alias="itemOrder", max_length=MAX_MENU_GROUPS)
    item_groups: dict[MenuId, MenuId] = Field(
        alias="itemGroups", max_length=MAX_MENU_ENTRIES
    )
    pinned_items: list[MenuId] = Field(alias="pinnedItems", max_length=MAX_MENU_ENTRIES)
    pinned_groups: list[MenuId] = Field(
        alias="pinnedGroups", max_length=MAX_MENU_GROUPS
    )
    hidden_items: list[MenuId] = Field(alias="hiddenItems", max_length=MAX_MENU_ENTRIES)


async def get_menu_layout(db: AsyncSession, user_id: str) -> MenuLayout | None:
    row = await db.get(UserMenuLayout, user_id)
    return None if row is None else MenuLayout.model_validate(row.layout, strict=False)


async def set_menu_layout(
    db: AsyncSession, user_id: str, layout: MenuLayout
) -> MenuLayout:
    """Create or replace the person's row with a layout the schema checked."""
    stored = layout.model_dump(by_alias=True)
    row = await db.get(UserMenuLayout, user_id)
    if row is None:
        db.add(UserMenuLayout(user_id=user_id, layout=stored))
    else:
        row.layout = stored
    await db.commit()
    return layout
