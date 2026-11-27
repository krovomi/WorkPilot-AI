"""What an organization lets the server collect about its members' usage.

Kept in the organization's ``settings`` under ``usage``:

- ``page_activity``: whether its members' apps send which pages they open
  (:mod:`server.services.page_activity`). **Off by default**: an
  organization turns it on once its members are told, and the change is
  audited (``org.usage_settings.updated``);
- ``usage_retention_days`` and ``page_activity_retention_days``: how long its
  token use and presence, and its page counts, are kept before they are
  erased; ``None`` keeps the server's (``WORKPILOT_USAGE_RETENTION_DAYS``,
  365, and ``WORKPILOT_PAGE_ACTIVITY_RETENTION_DAYS``, 183), always between
  :data:`MIN_DAYS` and :data:`MAX_DAYS`.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from server.config import get_settings
from server.db.models import Organization
from sqlalchemy.ext.asyncio import AsyncSession

KEY = "usage"
MIN_DAYS = 30
MAX_DAYS = 3650


def bounded(days: int) -> int:
    return min(max(days, MIN_DAYS), MAX_DAYS)


@dataclass(frozen=True)
class UsageSettings:
    page_activity: bool = False
    #: When page activity was last turned on (ISO 8601), for the notice.
    page_activity_since: str | None = None
    usage_retention_days: int | None = None
    page_activity_retention_days: int | None = None

    def usage_retention(self) -> timedelta:
        days = self.usage_retention_days or get_settings().usage_retention_days
        return timedelta(days=bounded(days))

    def page_activity_retention(self) -> timedelta:
        days = (
            self.page_activity_retention_days
            or get_settings().page_activity_retention_days
        )
        return timedelta(days=bounded(days))

    def as_dict(self) -> dict:
        return {
            "page_activity": self.page_activity,
            "page_activity_since": self.page_activity_since,
            "usage_retention_days": self.usage_retention_days,
            "page_activity_retention_days": self.page_activity_retention_days,
        }


def _days(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return bounded(value)


def of(settings: dict | None) -> UsageSettings:
    """An organization's usage settings, read from its ``settings`` column."""
    raw = (settings or {}).get(KEY)
    if not isinstance(raw, dict):
        return UsageSettings()
    since = raw.get("page_activity_since")
    return UsageSettings(
        page_activity=raw.get("page_activity") is True,
        page_activity_since=since if isinstance(since, str) else None,
        usage_retention_days=_days(raw.get("usage_retention_days")),
        page_activity_retention_days=_days(raw.get("page_activity_retention_days")),
    )


async def of_org(db: AsyncSession, org_id: str | None) -> UsageSettings:
    if org_id is None:
        return UsageSettings()
    org = await db.get(Organization, org_id)
    return of(org.settings if org is not None else None)


def store(org: Organization, settings: UsageSettings) -> None:
    """Write the usage settings into the organization's row (not committed)."""
    merged = dict(org.settings or {})
    merged[KEY] = settings.as_dict()
    org.settings = merged
