"""A person's interface preferences, stored once for all their devices.

The desktop and the phone read them at sign-in and write them when the
person changes their theme. Only closed lists are accepted: the mode of the
desktop's settings (``AppSettings.theme``) and the ids of its colour themes
(``apps/frontend/src/shared/constants/themes.ts``).
"""

from __future__ import annotations

from typing import Literal, get_args

from server.db.models import UserPreference
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
