"""``notifications/progress`` for a long tool call, when the client asked for it.

MCP lets a client put a ``progressToken`` in a request's ``_meta``; the server
may then send ``notifications/progress`` for that token until it answers, and
must stay silent when there is none. hermes-agent relays those notifications
to the person since v0.23.0 (``tools/mcp_tool_handlers.py``); Claude Code and
the MCP Inspector show them too. Without them, ``wait_for_card`` is an hour
of nothing on the client's side.

A tool reports through `report_progress`, which is a no-op unless the server
bound a sender for the call in progress: a tool body never needs to know
whether its client listens, which transport carries the call, or what the
token was. The binding is a context variable, so it follows the call into
``asyncio.to_thread`` and into a task the `TaskStore` runs, and two calls never
see each other's token.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

__all__ = ["Notify", "bind_progress", "report_progress"]

#: Writes one JSON-RPC notification to the client.
Notify = Callable[[dict[str, Any]], None]


class _Reporter:
    def __init__(self, notify: Notify, token: str | int) -> None:
        self._notify = notify
        self._token = token
        self._last: float | None = None

    def __call__(
        self, progress: float, total: float | None = None, message: str = ""
    ) -> None:
        # The spec wants each value larger than the last; a tool that reports
        # the same figure twice (a heartbeat in the same second) is nudged
        # rather than dropped, so its message still reaches the person.
        if self._last is not None and progress <= self._last:
            progress = self._last + 0.001
        self._last = progress
        params: dict[str, Any] = {"progressToken": self._token, "progress": progress}
        if total is not None:
            params["total"] = total
        if message:
            params["message"] = message
        try:
            self._notify(
                {"jsonrpc": "2.0", "method": "notifications/progress", "params": params}
            )
        except (OSError, ValueError):
            # A client that went away mid-call is the transport's problem;
            # the tool still owes its result to whoever is left.
            pass


_current: ContextVar[_Reporter | None] = ContextVar("mcp_progress", default=None)


@contextmanager
def bind_progress(notify: Notify | None, token: Any) -> Iterator[None]:
    """Route `report_progress` to *notify* for the duration of one call.

    Binds nothing when there is no sender or no usable token: a string or an
    integer, as the spec types it (a boolean is not an integer here).
    """
    usable = isinstance(token, (str, int)) and not isinstance(token, bool)
    if notify is None or not usable or token == "":
        yield
        return
    handle = _current.set(_Reporter(notify, token))
    try:
        yield
    finally:
        _current.reset(handle)


def report_progress(
    progress: float, total: float | None = None, message: str = ""
) -> None:
    """Tell the client how far the current call got. A no-op when nobody asked."""
    reporter = _current.get()
    if reporter is not None:
        reporter(progress, total, message)
