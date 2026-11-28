"""When and to whom an organization's usage report goes.

Kept in the organization's ``settings`` under ``usage_report``:

- ``enabled``: whether the daily report is sent (on by default);
- ``time`` (``HH:MM``) and ``timezone`` (an IANA name): when, in that time
  zone (``WORKPILOT_REPORT_TIMEZONE``, Europe/Paris by default, until the
  organization sets its own); 9:00 by default;
- ``days``: the weekdays it goes on (0 Monday to 6 Sunday), every day by
  default;
- ``recipients``: the addresses it goes to; empty, it goes to the members
  whose role reads usage (``usage.read``);
- ``language``: ``fr`` or ``en`` (``WORKPILOT_REPORT_LANGUAGE`` by default);
- ``names``: whether people are named; off, the report gives totals only;
- ``weekly`` and ``monthly``: a report of the past week each Monday, of the
  past month each first of the month, at the same time (off by default).

A value that does not read is replaced by its default, so a hand-edited row
never stops the reports.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import time
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from server.config import get_settings
from server.db.models import Organization

KEY = "usage_report"
LANGUAGES = ("fr", "en")
EVERY_DAY = (0, 1, 2, 3, 4, 5, 6)
MAX_RECIPIENTS = 20
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
#: A plain address: one ``@``, no space, a dot in the domain.
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]+$")


def zone_of(name: object) -> ZoneInfo | None:
    """The time zone of an IANA name, or None when there is no such zone."""
    if not isinstance(name, str) or not name or len(name) > 64:
        return None
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        return None


def is_address(value: object) -> bool:
    return isinstance(value, str) and len(value) <= 254 and bool(_EMAIL.match(value))


def _default_zone() -> str:
    name = get_settings().report_timezone
    return name if zone_of(name) else "UTC"


def _default_language() -> str:
    language = get_settings().report_language
    return language if language in LANGUAGES else "fr"


@dataclass(frozen=True)
class ReportSettings:
    enabled: bool = True
    time: str = "09:00"
    timezone: str = field(default_factory=_default_zone)
    days: tuple[int, ...] = EVERY_DAY
    recipients: tuple[str, ...] = ()
    language: str = field(default_factory=_default_language)
    names: bool = True
    weekly: bool = False
    monthly: bool = False

    @property
    def at(self) -> time:
        hours, minutes = self.time.split(":")
        return time(int(hours), int(minutes))

    @property
    def zone(self) -> ZoneInfo:
        return zone_of(self.timezone) or ZoneInfo("UTC")

    def as_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "time": self.time,
            "timezone": self.timezone,
            "days": list(self.days),
            "recipients": list(self.recipients),
            "language": self.language,
            "names": self.names,
            "weekly": self.weekly,
            "monthly": self.monthly,
        }


def clean_recipients(values: object) -> tuple[str, ...]:
    """Valid addresses, lower-cased, each once, in their order, at most 20."""
    if not isinstance(values, list | tuple):
        return ()
    seen: list[str] = []
    for value in values:
        if is_address(value) and (address := value.strip().lower()) not in seen:
            seen.append(address)
    return tuple(seen[:MAX_RECIPIENTS])


def of(settings: dict | None) -> ReportSettings:
    """An organization's report settings, read from its ``settings`` column."""
    raw = (settings or {}).get(KEY)
    if not isinstance(raw, dict):
        return ReportSettings()
    default = ReportSettings()
    days = raw.get("days")
    clean_days = (
        tuple(sorted({d for d in days if isinstance(d, int) and 0 <= d <= 6}))
        if isinstance(days, list)
        else ()
    )
    at = raw.get("time")
    language = raw.get("language")

    def flag(name: str, fallback: bool) -> bool:
        value = raw.get(name)
        return value if isinstance(value, bool) else fallback

    return ReportSettings(
        enabled=flag("enabled", default.enabled),
        time=at if isinstance(at, str) and _TIME.match(at) else default.time,
        timezone=raw["timezone"] if zone_of(raw.get("timezone")) else default.timezone,
        days=clean_days or default.days,
        recipients=clean_recipients(raw.get("recipients")),
        language=language if language in LANGUAGES else default.language,
        names=flag("names", default.names),
        weekly=flag("weekly", default.weekly),
        monthly=flag("monthly", default.monthly),
    )


def valid_time(value: str) -> bool:
    return bool(_TIME.match(value))


def store(org: Organization, settings: ReportSettings) -> None:
    """Write the report settings into the organization's row (not committed)."""
    merged = dict(org.settings or {})
    merged[KEY] = settings.as_dict()
    org.settings = merged
