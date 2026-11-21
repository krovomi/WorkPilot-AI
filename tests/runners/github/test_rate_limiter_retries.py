"""How the GitHub runner waits, retries and gives up when GitHub says "slow down".

`rate_limiter.py` holds the token bucket every gh call draws from and the
`@rate_limited` decorator that retries a rate-limited call with exponential
backoff. A run that keeps hitting the limit has to stop with a clear error, and
any other error has to surface at once rather than be retried.
"""

from __future__ import annotations

import asyncio
import sys
import time
import types

import pytest
from rate_limiter import (
    RateLimiter,
    RateLimitExceeded,
    TokenBucket,
    check_rate_limit,
    rate_limited,
)

#: The module itself, for the tests that replace its clock.
rate_limiter_module = sys.modules[RateLimiter.__module__]


@pytest.fixture(autouse=True)
def fresh_limiter():
    RateLimiter.reset_instance()
    yield
    RateLimiter.reset_instance()


class TickingClock:
    """A monotonic clock that moves on by `step` each time it is read."""

    def __init__(self, step: float) -> None:
        self.now, self.step = 0.0, step

    def monotonic(self) -> float:
        self.now += self.step
        return self.now


def test_a_wait_that_outlives_its_deadline_gives_up(monkeypatch):
    clock = TickingClock(step=0.2)
    monkeypatch.setattr(
        rate_limiter_module,
        "time",
        types.SimpleNamespace(
            **{k: getattr(time, k) for k in dir(time) if not k.startswith("_")},
        ),
    )
    monkeypatch.setattr(rate_limiter_module.time, "monotonic", clock.monotonic)
    bucket = TokenBucket(capacity=1, refill_rate=0.5)
    bucket.try_acquire(1)
    # Inside the deadline when it is checked (0.4s of 0.5s), past it one read
    # later, before any sleep: the bucket answers now instead of oversleeping.
    assert asyncio.run(bucket.acquire(1, timeout=0.5)) is False


def test_a_full_bucket_needs_no_wait():
    assert TokenBucket(capacity=3, refill_rate=1.0).time_until_available(2) == 0.0


def test_an_empty_bucket_says_how_long_to_wait():
    limiter = RateLimiter.get_instance(github_limit=1, github_refill_rate=0.5)
    limiter.github_bucket.try_acquire(1)
    available, message = limiter.check_github_available()
    assert available is False
    assert message.startswith("Rate limited. Wait ")
    assert message.endswith("s for next request")


def test_building_the_limiter_again_keeps_its_counts():
    limiter = RateLimiter.get_instance()
    limiter.github_requests = 7
    RateLimiter()  # someone constructs it directly
    assert limiter.github_requests == 7


def test_a_thread_that_waited_for_bootstrap_gets_the_instance_already_made(
    monkeypatch,
):
    made_meanwhile = RateLimiter()

    class OtherThreadFinishedFirst:
        def __enter__(self):
            RateLimiter._instance = made_meanwhile

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(RateLimiter, "_instance_lock", OtherThreadFinishedFirst())
    assert RateLimiter.get_instance() is made_meanwhile


def test_a_rate_limited_call_is_retried_after_a_backoff(capsys):
    attempts = []

    @rate_limited(operation_type="github", max_retries=2, base_delay=0.001)
    async def fetch():
        attempts.append(1)
        if len(attempts) == 1:
            raise RateLimitExceeded("secondary rate limit")
        return "ok"

    assert asyncio.run(fetch()) == "ok"
    assert len(attempts) == 2
    assert "[RateLimit] Retry 1/2 after 0.0s: secondary rate limit" in (
        capsys.readouterr().out
    )


def test_a_403_that_keeps_coming_ends_the_run_as_rate_limited():
    @rate_limited(operation_type="github", max_retries=1, base_delay=0.001)
    async def fetch():
        raise RuntimeError("HTTP 403: API rate limit exceeded")

    with pytest.raises(RateLimitExceeded, match="HTTP 403/429"):
        asyncio.run(fetch())
    assert RateLimiter.get_instance().github_errors == 2


def test_any_other_error_surfaces_at_once():
    attempts = []

    @rate_limited(operation_type="github", max_retries=3)
    async def fetch():
        attempts.append(1)
        raise ValueError("bad JSON from gh")

    with pytest.raises(ValueError, match="bad JSON"):
        asyncio.run(fetch())
    assert attempts == [1]


def test_a_call_that_is_not_github_spends_no_token():
    @rate_limited(operation_type="ai")
    async def summarise():
        return "summary"

    assert asyncio.run(summarise()) == "summary"
    assert RateLimiter.get_instance().github_requests == 0


def test_a_plain_function_is_run_in_its_own_event_loop():
    @rate_limited(operation_type="github")
    def count_labels(n):
        return n + 1

    assert count_labels(2) == 3
    assert RateLimiter.get_instance().github_requests == 1


def test_a_pre_flight_check_for_anything_else_lets_it_through():
    asyncio.run(check_rate_limit("search"))
