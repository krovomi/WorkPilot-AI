"""Structured, user-facing error details for runner-driven features.

A runner that dies with ``sys.exit(1)`` and a one-line message tells the UI that
something failed and nothing else. The user is left in front of a red step with
no idea whether their provider is unauthenticated, rate-limited, or whether the
source file simply could not be read — three problems with three different
fixes.

``ErrorDetail`` is the shape every such runner reports instead: a short message,
a machine-readable ``code`` the UI turns into a title and an actionable hint, the
pipeline ``stage`` it died on, and the raw technical text (traceback tail,
provider diagnostic) folded away behind a disclosure.

The technical text is **redacted** before it leaves the process: provider
diagnostics routinely echo the Authorization header that failed, and an error
panel with a copy button is exactly the kind of thing that ends up pasted into
an issue tracker.
"""

from __future__ import annotations

import dataclasses
import re
from typing import Any

# ── Error codes ──────────────────────────────────────────────────────
# Kept as plain strings rather than an Enum: they cross a JSON boundary into
# TypeScript, where the union type is the source of truth for the UI copy.

AUTH = "auth"
RATE_LIMIT = "rate_limit"
QUOTA = "quota"
NETWORK = "network"
TIMEOUT = "timeout"
PROVIDER_UNAVAILABLE = "provider_unavailable"
EMPTY_RESPONSE = "empty_response"
FILE_NOT_FOUND = "file_not_found"
WRITE_FAILED = "write_failed"
PARSE_FAILED = "parse_failed"
INVALID_INPUT = "invalid_input"
UNKNOWN = "unknown"

# ── Redaction ────────────────────────────────────────────────────────
# Ordered most-specific first: a `Bearer sk-ant-…` must be caught by the bearer
# rule before the bare-token rule sees it, so the replacement reads sensibly.

_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    # Authorization / bearer headers
    (re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._\-+/=]{8,}"), r"\1 «redacted»"),
    # key=value / "key": "value" forms for anything that smells like a secret
    (
        re.compile(
            r"(?i)\b([a-z0-9_.\-]*(?:api[_-]?key|secret|token|password|passwd|credential|authorization)"
            r"[a-z0-9_.\-]*)\b(\s*[:=]\s*)([\"']?)[^\s\"',;)]{4,}\3"
        ),
        r"\1\2«redacted»",
    ),
    # Well-known token shapes, even when they appear bare in a message
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{16,}"), "«redacted»"),
    (
        re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}"),
        "«redacted»",
    ),
    (re.compile(r"\bxox[abposr]-[A-Za-z0-9\-]{10,}"), "«redacted»"),
    # JWTs
    (
        re.compile(r"\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}"),
        "«redacted»",
    ),
)


def redact(text: str | None) -> str:
    """Strip anything that looks like a credential out of ``text``.

    Deliberately eager: a false positive costs one unreadable word in a
    technical-details panel, a false negative leaks a token into whatever the
    user pastes that panel into.
    """
    if not text:
        return ""
    out = str(text)
    for pattern, replacement in _REDACTIONS:
        out = pattern.sub(replacement, out)
    return out


# ── Classification ───────────────────────────────────────────────────
# Matched against the lower-cased concatenation of the exception type, its
# message and any provider diagnostic. First match wins, so the order encodes
# priority: an auth failure that also mentions "connection" is an auth failure.

_SIGNATURES: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        AUTH,
        (
            "unauthorized",
            "unauthenticated",
            "authentication",
            "invalid api key",
            "invalid_api_key",
            "no api key",
            "api key not found",
            "oauth",
            "401",
            "403",
            "forbidden",
            "credential",
            "permission denied for",
            "please run /login",
        ),
    ),
    (
        RATE_LIMIT,
        ("rate limit", "rate_limit", "429", "too many requests", "overloaded"),
    ),
    (
        QUOTA,
        (
            "quota",
            "insufficient_quota",
            "billing",
            "credit balance",
            "payment required",
            "402",
        ),
    ),
    (TIMEOUT, ("timeout", "timed out", "deadline exceeded")),
    (
        NETWORK,
        (
            # Bare "connection" on purpose: Python's own exception names run the
            # words together (ConnectionRefusedError), and the buckets that could
            # be confused with a transport problem — auth, rate limit, quota,
            # timeout — are all matched before this one.
            "connection",
            "network",
            "dns",
            "getaddrinfo",
            "ssl",
            "certificate",
            "proxy",
            "unreachable",
        ),
    ),
    (
        PROVIDER_UNAVAILABLE,
        (
            "not installed",
            "command not found",
            "no such file or directory: 'claude'",
            "executable",
            "cli not found",
            "modulenotfounderror",
            "importerror",
            "503",
            "502",
            "service unavailable",
            "bad gateway",
        ),
    ),
    (FILE_NOT_FOUND, ("filenotfounderror", "cannot read source file", "no such file")),
    (
        WRITE_FAILED,
        (
            "permissionerror",
            "read-only file system",
            "oserror",
            "disk",
            "isadirectoryerror",
        ),
    ),
    (
        PARSE_FAILED,
        ("jsondecodeerror", "could not parse", "expecting value", "invalid json"),
    ),
)


def classify(*fragments: str | None) -> str:
    """Best-effort mapping from raw error text to one of the codes above."""
    haystack = " ".join(f for f in fragments if f).lower()
    if not haystack.strip():
        return UNKNOWN
    for code, needles in _SIGNATURES:
        if any(needle in haystack for needle in needles):
            return code
    return UNKNOWN


@dataclasses.dataclass
class ErrorDetail:
    """Everything the UI needs to explain one failure to a human."""

    message: str
    code: str = UNKNOWN
    stage: str | None = None
    details: str | None = None
    provider: str | None = None
    model: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON payload for the runner protocol. Redacted, empty keys dropped."""
        payload: dict[str, Any] = {
            "message": redact(self.message).strip(),
            "code": self.code or UNKNOWN,
        }
        details = redact(self.details).strip()
        if details:
            # Keep the tail: the useful part of a traceback or a provider log is
            # at the end, and the panel is scrollable, not infinite.
            payload["details"] = details[-4000:]
        for key in ("stage", "provider", "model"):
            value = getattr(self, key)
            if value:
                payload[key] = value
        return payload


class DetailedError(RuntimeError):
    """An exception that already knows how it should be shown to the user.

    Subclasses ``RuntimeError`` rather than ``Exception`` so that code (and
    tests) catching the generic runtime failure it replaces keep working.
    """

    def __init__(self, detail: ErrorDetail) -> None:
        super().__init__(detail.message)
        self.detail = detail
