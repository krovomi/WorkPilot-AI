"""What a provider's error says about the account it ran on.

A session error is classified once (``agents.session``), and the coder, the
planner and the QA shield act on the class: a rate limit waits or pauses, an
authentication failure pauses for a new sign-in. Every provider words these
its own way (Anthropic, OpenAI, Google, Mistral, DeepSeek, OpenRouter...);
this module knows the wordings, so the pause, and from it the automatic
failover to the next account (``docs/architecture/provider-failover.md``),
works for all of them.
"""

from __future__ import annotations

import re

__all__ = [
    "is_authentication_error",
    "is_quota_exhausted",
    "is_rate_limit_error",
]

# A spent quota or balance: retrying on the same account cannot work until
# the person tops it up or the period ends, so the account must change.
_QUOTA_EXHAUSTED = (
    "insufficient_quota",  # OpenAI, OpenRouter
    "exceeded your current quota",  # OpenAI
    "resource_exhausted",  # Google (gRPC status)
    "resource exhausted",
    "quota exceeded",  # Google "Quota exceeded for metric", Mistral
    "insufficient balance",  # DeepSeek (HTTP 402)
    "insufficient_balance",
    "insufficient credits",  # OpenRouter
    "insufficient_credits",
    "credit balance is too low",  # Anthropic API
    "payment required",  # HTTP 402
)

_RATE_LIMITED = (
    "limit reached",
    "rate limit",
    "rate_limit",  # SDK may use underscore variant (e.g., "rate_limit_event")
    # The Claude CLI shapes "You've hit your limit · resets …" and the newer
    # "You've hit your session limit · resets …" / "weekly limit" variants.
    # Missing the session/weekly word once made the coder retry until the
    # summarised prompt itself blew the context window.
    "hit your limit",
    "hit your session limit",
    "hit your weekly limit",
    "session limit",
    "weekly limit",
    "too many requests",
    "usage limit",
)

_UNAUTHENTICATED = (
    "authentication failed",
    "authentication error",
    "unauthorized",
    "invalid token",
    "token expired",
    "authentication_error",
    "invalid_token",
    "token_expired",
    "not authenticated",
    "http 401",
    # API keys refused by the provider (OpenAI, Mistral, DeepSeek: 401;
    # Google answers 400 "API key not valid" / API_KEY_INVALID).
    "invalid api key",
    "invalid_api_key",
    "incorrect api key",
    "api key not valid",
    "api_key_invalid",
)


# A per-minute quota (Google "... requests per minute") lifts by itself.
_SHORT_WINDOW = re.compile(r"per[\s_-]?minute|perminute|per[\s_-]?second")


def is_quota_exhausted(error: Exception | str) -> bool:
    """Whether the account's quota, credits or balance are spent (402 included)."""
    text = str(error).lower()
    if _SHORT_WINDOW.search(text):
        return False
    return bool(re.search(r"\b402\b", text)) or any(p in text for p in _QUOTA_EXHAUSTED)


def is_rate_limit_error(error: Exception) -> bool:
    """
    Check if an error is a rate limit error (429, a spent quota or similar).

    Args:
        error: The exception to check

    Returns:
        True if this is a rate limit error, False otherwise
    """
    error_str = str(error).lower()
    # HTTP 429 with word boundaries to avoid false positives
    if re.search(r"\b429\b", error_str):
        return True
    return any(p in error_str for p in _RATE_LIMITED) or is_quota_exhausted(error_str)


def is_authentication_error(error: Exception) -> bool:
    """
    Check if an error is an authentication error (401, token expired, a key refused).

    HTTP 401 is checked with word boundaries; the other patterns are the
    providers' own wordings. A generic "unauthorized" may match an unrelated
    error: the cost is a pause the person resumes from, which is acceptable.

    Args:
        error: The exception to check

    Returns:
        True if this is an authentication error, False otherwise
    """
    error_str = str(error).lower()
    if re.search(r"\b401\b", error_str):
        return True
    return any(p in error_str for p in _UNAUTHENTICATED)
