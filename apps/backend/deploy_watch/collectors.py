"""Read a health check and Prometheus (#366).

Only the URLs of the project's CI/CD settings are read. Every request is
bounded (10 s, 1 MB), follows no redirect, and the Prometheus token is sent
only over https or to the machine itself. What comes back is a number or a
status code, never run.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from urllib.parse import urlencode

from .net import MAX_BODY_BYTES, TIMEOUT_SECONDS, Fetch, HealthResult, token_allowed


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect())


def default_fetch(request: urllib.request.Request) -> tuple[int, bytes]:
    try:
        with _OPENER.open(request, timeout=TIMEOUT_SECONDS) as response:
            return response.status, response.read(MAX_BODY_BYTES + 1)
    except urllib.error.HTTPError as error:
        return error.code, b""


def health_check(url: str, fetch: Fetch = default_fetch) -> HealthResult:
    request = urllib.request.Request(
        url, method="GET", headers={"User-Agent": "WorkPilot"}
    )
    try:
        status, _body = fetch(request)
    except (OSError, ValueError) as error:
        return HealthResult(ok=False, error=type(error).__name__)
    return HealthResult(ok=200 <= status < 400, status=status)


def prometheus_value(
    base_url: str, token: str, query: str, fetch: Fetch = default_fetch
) -> float | None:
    """The value of an instant query: a scalar, or the sum of a vector."""
    headers = {"Accept": "application/json", "User-Agent": "WorkPilot"}
    if token and token_allowed(base_url):
        headers["Authorization"] = f"Bearer {token}"
    url = f"{base_url}/api/v1/query?{urlencode({'query': query})}"
    try:
        status, body = fetch(urllib.request.Request(url, method="GET", headers=headers))
    except (OSError, ValueError):
        return None
    if status != 200 or len(body) > MAX_BODY_BYTES:
        return None
    try:
        data = json.loads(body.decode("utf-8")).get("data") or {}
        result = data.get("result") or []
        if data.get("resultType") == "scalar":
            values = [result[1]]
        else:
            values = [item["value"][1] for item in result]
        numbers = [float(v) for v in values]
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        return None
    if not numbers or any(math.isnan(n) or math.isinf(n) for n in numbers):
        return None
    return sum(numbers)
