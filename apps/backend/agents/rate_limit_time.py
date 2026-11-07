"""When a rate-limited provider says it will accept work again.

The CLI and the API say it in prose ("resets at 10:30 pm", "resets 3pm
(Europe/Paris)", "try again in 20 minutes"). These parsers turn that into a
Unix timestamp for `agents.coder`'s wait-and-resume, which imports
``parse_rate_limit_reset_time`` from here.
"""

from __future__ import annotations

import re
from datetime import datetime, timedelta

__all__ = ["parse_rate_limit_reset_time"]


def _parse_relative_time(message: str) -> int | None:
    """Parse 'in X minutes/hours' pattern from message."""
    in_time_match = re.search(r"in\s+(\d+)\s*(minute|hour|min|hr)s?", message, re.I)
    if not in_time_match:
        return None

    amount = int(in_time_match.group(1))
    unit = in_time_match.group(2).lower()

    if unit.startswith("hour") or unit.startswith("hr"):
        delta = timedelta(hours=amount)
    else:
        delta = timedelta(minutes=amount)

    return int((datetime.now() + delta).timestamp())


def _validate_time_values(hour: int, minute: int) -> bool:
    """Validate hour and minute ranges."""
    return 0 <= hour <= 23 and 0 <= minute <= 59


def _convert_meridiem_to_24h(hour: int, meridiem: str) -> int:
    """Convert 12-hour format with meridiem to 24-hour format."""
    if meridiem.lower() == "pm" and hour < 12:
        return hour + 12
    elif meridiem.lower() == "am" and hour == 12:
        return 0
    return hour


def _validate_meridiem_hour(hour: int, meridiem: str) -> bool:
    """Validate hour range when meridiem is present (should be 1-12)."""
    return 1 <= hour <= 12


def _parse_absolute_time(message: str) -> int | None:
    """Parse absolute clock times from CLI messages.

    Handles both shapes the Claude CLI emits:
      - ``"resets at 10:30 pm"`` / ``"resets at 22:30"`` (legacy)
      - ``"resets 3:20pm (Europe/Paris)"`` / ``"resets 10am"`` (newer session-limit
        and weekly-limit banners — no ``at`` prefix, minute portion sometimes
        omitted)

    Missing the no-``at`` variant let the rate-limit shield fail to compute a
    reset timestamp, so the caller fell back to its retry loop and the
    conversation summary kept re-injecting until the prompt overflowed.
    """
    # Try minute-precision first (HH:MM with optional meridiem).
    at_time_match = re.search(
        r"(?:at|resets)\s+(\d{1,2}):(\d{2})\s*(am|pm)?", message, re.I
    )
    if not at_time_match:
        # Fall back to hour-only ("resets 10am" / "resets 3pm").
        hour_only = re.search(r"(?:at|resets)\s+(\d{1,2})\s*(am|pm)", message, re.I)
        if not hour_only:
            return None
        # Synthesise a zero-minute match so the rest of the function stays one branch.
        try:
            hour = int(hour_only.group(1))
        except ValueError:
            return None
        minute = 0
        meridiem = hour_only.group(2)
    else:
        try:
            hour = int(at_time_match.group(1))
            minute = int(at_time_match.group(2))
        except ValueError:
            return None
        meridiem = at_time_match.group(3)

    try:
        # Validate hour range when meridiem is present
        if meridiem and not _validate_meridiem_hour(hour, meridiem):
            return None

        if meridiem:
            hour = _convert_meridiem_to_24h(hour, meridiem)

        # Validate final hour and minute ranges
        if not _validate_time_values(hour, minute):
            return None

        now = datetime.now()
        reset_time = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if reset_time <= now:
            reset_time += timedelta(days=1)
        return int(reset_time.timestamp())
    except ValueError:
        return None


def parse_rate_limit_reset_time(error_info: dict | None) -> int | None:
    """
    Parse rate limit reset time from error info.

    Attempts to extract reset time from various formats in error messages.

    TIMEZONE ASSUMPTIONS:
    - "in X minutes/hours" patterns are timezone-safe (relative time)
    - "at HH:MM" patterns assume LOCAL timezone, which is reasonable since:
      1. The user sees timestamps in their local timezone
      2. The wait calculation happens locally using datetime.now()
      3. If the API returns UTC "at" times, this would need adjustment
        (but Claude API typically returns relative times like "in X minutes")

    Args:
        error_info: Error info dict with 'message' key

    Returns:
        Unix timestamp of reset time, or None if not parseable
    """
    if not error_info:
        return None

    message = error_info.get("message", "")

    # Try relative time pattern first
    reset_time = _parse_relative_time(message)
    if reset_time:
        return reset_time

    # Try absolute time pattern
    reset_time = _parse_absolute_time(message)
    if reset_time:
        return reset_time

    # No pattern matched
    return None
