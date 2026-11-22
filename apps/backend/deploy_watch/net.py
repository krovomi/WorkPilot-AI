"""What every request of the deployment watch shares (#366).

A leaf: the URL checks, the bound on an answer, the shape of a fetch and
what a health check answered,
read by the collectors, the metric sources, the alerts and the rollback
without importing one another.
"""

from __future__ import annotations

import ipaddress
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import urlsplit

TIMEOUT_SECONDS = 10
MAX_BODY_BYTES = 1024 * 1024

# (request) -> (status, body); raises OSError when the host cannot be reached.
Fetch = Callable[[urllib.request.Request], tuple[int, bytes]]


@dataclass(frozen=True)
class HealthResult:
    """What a health check answered: a status, or why none came back."""

    ok: bool
    status: int | None = None
    error: str = ""

    def to_dict(self) -> dict:
        return {"ok": self.ok, "status": self.status, "error": self.error}


def valid_url(value: str) -> bool:
    """An http(s) URL with a host and no credentials in it."""
    try:
        parts = urlsplit(value)
    except ValueError:
        return False
    return (
        parts.scheme in ("http", "https")
        and bool(parts.hostname)
        and parts.username is None
        and parts.password is None
        and not any(ch.isspace() for ch in value)
    )


def is_local_host(url: str) -> bool:
    """Loopback or a private address literal: reachable without leaving the site."""
    host = (urlsplit(url).hostname or "").strip("[]")
    if host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private


def token_allowed(url: str) -> bool:
    """A token goes only over https or to the machine itself."""
    return urlsplit(url).scheme == "https" or is_local_host(url)
