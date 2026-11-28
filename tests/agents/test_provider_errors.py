"""Every provider's wording of a limit, a spent quota or a refused key.

The coder pauses on these, and the pause hands the task to the next account
of the failover chain: a wording missed here is a task that retries forever on
an account that cannot answer.
"""

from __future__ import annotations

import pytest
from agents.provider_errors import (
    is_authentication_error,
    is_quota_exhausted,
    is_rate_limit_error,
)

pytestmark = pytest.mark.unit


@pytest.mark.parametrize(
    "message",
    [
        "Error code: 429 - {'error': {'message': 'You exceeded your current quota', 'type': 'insufficient_quota'}}",
        "429 RESOURCE_EXHAUSTED: Resource has been exhausted (e.g. check quota).",
        "Error code: 402 - {'error': {'message': 'Insufficient Balance'}}",
        "OpenRouter: insufficient credits, add more to continue",
        "Your credit balance is too low to access the Anthropic API.",
        "HTTP 402 Payment Required",
    ],
)
def test_a_spent_quota_is_a_rate_limit_that_retrying_cannot_get_past(
    message: str,
) -> None:
    assert is_quota_exhausted(message) is True
    assert is_rate_limit_error(RuntimeError(message)) is True


@pytest.mark.parametrize(
    "message",
    [
        "429 Quota exceeded for quota metric 'Generate Content API requests per minute'",
        "Rate limit reached for requests per_second",
        "Requests rate limit exceeded",
        "Build 4021 failed",
        "",
    ],
)
def test_a_short_window_or_another_error_is_not_a_spent_quota(message: str) -> None:
    assert is_quota_exhausted(message) is False


@pytest.mark.parametrize(
    "message",
    [
        "Requests rate limit exceeded",  # Mistral
        "Too Many Requests",
        "You've hit your session limit · resets 3pm",
        "status 429",
    ],
)
def test_a_short_limit_is_a_rate_limit(message: str) -> None:
    assert is_rate_limit_error(RuntimeError(message)) is True


def test_unrelated_errors_are_neither() -> None:
    error = RuntimeError("FileNotFoundError: build/4290.log")
    assert is_rate_limit_error(error) is False
    assert is_authentication_error(error) is False


@pytest.mark.parametrize(
    "message",
    [
        "Error code: 401 - {'error': {'code': 'invalid_api_key'}}",
        "Incorrect API key provided: sk-****",
        "400 API key not valid. Please pass a valid API key. [reason: API_KEY_INVALID]",
        "Invalid API key",
        "OAuth token has expired: authentication_error",
    ],
)
def test_a_refused_key_is_an_authentication_failure(message: str) -> None:
    assert is_authentication_error(RuntimeError(message)) is True


def test_the_session_module_still_offers_both_checks() -> None:
    from agents import session

    assert session.is_rate_limit_error is is_rate_limit_error
    assert session.is_authentication_error is is_authentication_error
