"""The desktop app's local API answers only requests addressed to this machine.

The local backend listens on 127.0.0.1 and is called by the app's main
process as ``127.0.0.1`` or ``localhost``. A request whose ``Host`` names any
other host was not addressed to it, so it is answered 421 (Misdirected
Request) before any route runs. Hosts of the origins a person opted into with
``WORKPILOT_EXTRA_CORS_ORIGINS`` are accepted too. Server mode is reached by
its public name and has its own authentication: this check is not mounted
there (``provider_api``).

A pure ASGI middleware with no FastAPI import, so it sits in `foundation`.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from typing import Any
from urllib.parse import urlsplit

LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]


def host_name(header: str) -> str:
    """The host of a ``Host`` header, lower-cased, without its port."""
    value = header.strip().lower()
    if value.startswith("["):
        end = value.find("]")
        return value[1:end] if end > 0 else ""
    if value.count(":") == 1:
        value = value.split(":", 1)[0]
    return value.rstrip(".")


def origin_hosts(origins: Iterable[str]) -> frozenset[str]:
    """The hosts named by a list of origins (``http://name:port``)."""
    hosts = set()
    for origin in origins:
        try:
            name = urlsplit(origin.strip()).hostname
        except ValueError:
            continue
        if name:
            hosts.add(name.lower().rstrip("."))
    return frozenset(hosts)


class LoopbackHostOnly:
    """Answer 421 to a request whose ``Host`` is not this machine's."""

    def __init__(self, app: ASGIApp, extra_origins: Iterable[str] = ()) -> None:
        self.app = app
        self.allowed = LOOPBACK_HOSTS | origin_hosts(extra_origins)

    def addressed_here(self, scope: Scope) -> bool:
        for name, value in scope.get("headers") or ():
            if name == b"host":
                return host_name(value.decode("latin-1")) in self.allowed
        # No Host at all: not a browser (every browser sends one).
        return True

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        kind = scope.get("type")
        if kind not in ("http", "websocket") or self.addressed_here(scope):
            await self.app(scope, receive, send)
            return
        if kind == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = b"Misdirected request"
        await send(
            {
                "type": "http.response.start",
                "status": 421,
                "headers": [
                    (b"content-type", b"text/plain; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
