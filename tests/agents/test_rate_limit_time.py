"""When a rate-limited provider says it will take work again.

The coder and the rate-limit shield wait until the timestamp parsed here, so
a wrong parse is a build that waits a day, or not at all.
"""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest
from agents.rate_limit_time import parse_rate_limit_reset_time


def _parse(message: str) -> int | None:
    return parse_rate_limit_reset_time({"message": message})


@pytest.mark.parametrize(
    ("message", "delta"),
    [
        ("Rate limited, try again in 20 minutes", timedelta(minutes=20)),
        ("retry in 5 min", timedelta(minutes=5)),
        ("quota resets in 2 hours", timedelta(hours=2)),
        ("try again in 1 hr", timedelta(hours=1)),
    ],
)
def test_a_relative_delay_is_counted_from_now(message: str, delta: timedelta) -> None:
    expected = (datetime.now() + delta).timestamp()

    assert _parse(message) == pytest.approx(expected, abs=2)


@pytest.mark.parametrize(
    ("message", "hour", "minute"),
    [
        ("Session limit reached, resets at 10:30 pm", 22, 30),
        ("resets at 22:05", 22, 5),
        ("resets 3:20pm (Europe/Paris)", 15, 20),
        ("weekly limit, resets 10am", 10, 0),
        ("resets 12am", 0, 0),
        ("resets at 12:15 pm", 12, 15),
    ],
)
def test_a_clock_time_is_the_next_time_that_clock_shows_it(
    message: str, hour: int, minute: int
) -> None:
    before = datetime.now()

    reset = datetime.fromtimestamp(_parse(message))  # type: ignore[arg-type]

    assert (reset.hour, reset.minute, reset.second) == (hour, minute, 0)
    # Today if that time is still ahead, tomorrow otherwise: never in the past.
    assert before < reset <= before + timedelta(days=1)


@pytest.mark.parametrize(
    "message",
    [
        "resets at 13:00 pm",  # a 12-hour clock has no 13
        "resets 0am",
        "resets at 25:00",
        "resets at 10:75",
        "you have been rate limited",
        "",
    ],
)
def test_a_time_that_cannot_be_read_is_none(message: str) -> None:
    assert _parse(message) is None


def test_no_error_info_is_none() -> None:
    assert parse_rate_limit_reset_time(None) is None
    assert parse_rate_limit_reset_time({}) is None


def test_a_spent_quota_pauses_for_an_hour_when_no_reset_time_is_given() -> None:
    from agents.rate_limit_time import QUOTA_PAUSE_SECONDS, quota_pause

    before = datetime.now().timestamp()
    resume = quota_pause({"message": "Error code: 429 insufficient_quota"})
    assert resume is not None
    assert (
        before + QUOTA_PAUSE_SECONDS - 2 <= resume <= before + QUOTA_PAUSE_SECONDS + 2
    )


def test_a_short_limit_or_no_error_is_no_quota_pause() -> None:
    from agents.rate_limit_time import quota_pause

    assert quota_pause({"message": "429 Too Many Requests"}) is None
    assert quota_pause(None) is None
    assert quota_pause({}) is None
