"""A fetch that answers by URL prefix, and remembers each request."""

from __future__ import annotations

import json
import urllib.request

import pytest


class FakeFetch:
    def __init__(self, routes: dict[str, object] | None = None):
        # prefix -> (status, body object | bytes) | Exception | callable(request)
        self.routes = dict(routes or {})
        self.requests: list[urllib.request.Request] = []

    def __call__(self, request: urllib.request.Request) -> tuple[int, bytes]:
        self.requests.append(request)
        url = request.full_url
        for prefix in sorted(self.routes, key=len, reverse=True):
            if url.startswith(prefix):
                answer = self.routes[prefix]
                if callable(answer) and not isinstance(answer, tuple):
                    answer = answer(request)
                if isinstance(answer, BaseException):
                    raise answer
                status, body = answer  # type: ignore[misc]
                if isinstance(body, bytes):
                    return status, body
                return status, json.dumps(body).encode()
        raise OSError(f"no route for {url}")

    def urls(self) -> list[str]:
        return [r.full_url for r in self.requests]


@pytest.fixture
def fake_fetch():
    return FakeFetch


@pytest.fixture(autouse=True)
def no_model(monkeypatch):
    """No test reaches a real provider: the incident report's model answers ""."""
    import deploy_watch.incident as incident

    monkeypatch.setattr(incident, "_port_ask", lambda *a: "")
