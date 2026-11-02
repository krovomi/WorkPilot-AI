"""Who is on a server project right now, and its team chat (server mode).

The members of a project who follow its channel (``project:<id>``) form its
room. Each one receives, on the same stream as the board's events:

- ``presence``: who is in the room, by id and name (never an email), sent to
  everyone each time someone arrives or leaves;
- ``chat_history``: the latest messages, sent to the one who just arrived;
- ``chat_message``: a message, sent to everyone, the author included, once
  stored (``server.services.team_chat``);
- ``chat_rejected``: to the author alone, when a message was not taken.

Only people are in a room: the API's and the runs' service connections
publish on channels and are never listed. Local mode has no room: the chat of
a live session keeps its own path (``StreamingWebSocketServer``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

#: A socket that closed or broke while a room message was going out.
_SEND_ERRORS: tuple[type[BaseException], ...] = (OSError, RuntimeError)
#: The chat's store being unreachable or refusing a write.
_STORE_ERRORS: tuple[type[BaseException], ...] = (OSError, RuntimeError, ValueError)
try:
    from websockets.exceptions import WebSocketException

    _SEND_ERRORS += (WebSocketException,)
except ImportError:  # the server runs with websockets; some tests do not
    pass
try:
    from sqlalchemy.exc import SQLAlchemyError

    _STORE_ERRORS += (SQLAlchemyError,)
except ImportError:
    pass

PROJECT_PREFIX = "project:"
#: At most this many messages per person and connection in `_WINDOW` seconds.
_BURST = 5
_WINDOW = 5.0
_MAX_NAME = 120


@dataclass(frozen=True)
class Member:
    user_id: str
    name: str


def _event(channel: str, event_type: str, data: dict[str, Any]) -> str:
    return json.dumps(
        {
            "event_type": event_type,
            "timestamp": time.time(),
            "session_id": channel,
            "data": data,
        }
    )


async def _send(websocket: Any, payload: str) -> None:
    try:
        await websocket.send(payload)
    except _SEND_ERRORS as e:  # a closed socket leaves through its cleanup
        logger.debug("Room message not delivered: %s", type(e).__name__)


class ProjectRooms:
    """The rooms of the project channels this server holds."""

    def __init__(self) -> None:
        self._rooms: dict[str, dict[Any, Member]] = {}
        self._sent: dict[Any, deque[float]] = {}
        self._tasks: set[asyncio.Task] = set()

    # -- Who is in a room ---------------------------------------------------

    @staticmethod
    def member_of(ctx: dict) -> Member | None:
        """The person this connection is, when it belongs in a room."""
        channel = ctx.get("session_id") or ""
        claims = ctx.get("claims")
        grant = ctx.get("grant")
        if claims is None or grant is None or getattr(grant, "can_publish", False):
            return None
        if not channel.startswith(PROJECT_PREFIX):
            return None
        user_id = str(claims.get("sub") or "")
        if not user_id or user_id.startswith("service:"):
            return None
        name = " ".join(str(claims.get("name") or "").split())[:_MAX_NAME]
        return Member(user_id=user_id, name=name or "?")

    def roster(self, channel: str) -> list[dict[str, str]]:
        """Who is in the room, once each (a person may have two windows open)."""
        people = {m.user_id: m.name for m in self._rooms.get(channel, {}).values()}
        return [
            {"id": user_id, "name": name}
            for user_id, name in sorted(people.items(), key=lambda p: p[1].lower())
        ]

    async def enter(self, ctx: dict, websocket: Any) -> None:
        """Add the connection to its channel's room, if it belongs in one."""
        member = self.member_of(ctx)
        if member is None:
            return
        channel = ctx["session_id"]
        self._rooms.setdefault(channel, {})[websocket] = member
        await self._announce(channel)
        await self._send_history(channel, websocket)

    async def leave(self, channel: str | None, websocket: Any) -> None:
        if self._remove(channel, websocket):
            await self._announce(channel or "")

    def leave_soon(self, channel: str | None, websocket: Any) -> None:
        """`leave` from code that cannot wait (a connection's cleanup)."""
        if not self._remove(channel, websocket):
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        task = loop.create_task(self._announce(channel or ""))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _remove(self, channel: str | None, websocket: Any) -> bool:
        self._sent.pop(websocket, None)
        room = self._rooms.get(channel or "")
        if room is None or websocket not in room:
            return False
        del room[websocket]
        if not room:
            del self._rooms[channel or ""]
        return True

    async def _announce(self, channel: str) -> None:
        payload = _event(channel, "presence", {"users": self.roster(channel)})
        for websocket in list(self._rooms.get(channel, {})):
            await _send(websocket, payload)

    async def _send_history(self, channel: str, websocket: Any) -> None:
        from server.services.team_chat import recent_messages

        try:
            messages = await recent_messages(channel[len(PROJECT_PREFIX) :])
        except _STORE_ERRORS as e:  # the room works without its history
            logger.warning("Team chat history unavailable: %s", type(e).__name__)
            messages = []
        await _send(websocket, _event(channel, "chat_history", {"messages": messages}))

    # -- The chat -------------------------------------------------------------

    def is_room(self, ctx: dict, websocket: Any) -> bool:
        """Whether this connection's messages go to its room's chat."""
        return websocket in self._rooms.get(ctx.get("session_id") or "", {})

    def _allow(self, websocket: Any) -> bool:
        now = time.monotonic()
        sent = self._sent.setdefault(websocket, deque())
        while sent and now - sent[0] > _WINDOW:
            sent.popleft()
        if len(sent) >= _BURST:
            return False
        sent.append(now)
        return True

    async def chat(
        self, ctx: dict, websocket: Any, data: dict, *, allowed: bool
    ) -> None:
        """Store the message and send it to the room, or tell its author why not."""
        from server.services.team_chat import clean_message, save_message

        channel = ctx["session_id"]
        member = self._rooms.get(channel, {}).get(websocket)
        if member is None:
            return
        text = clean_message(data.get("message"))
        reason = None
        if not allowed:
            reason = "forbidden"
        elif text is None:
            reason = "invalid"
        elif not self._allow(websocket):
            reason = "too_fast"
        if reason is None and text is not None:
            try:
                stored = await save_message(
                    channel[len(PROJECT_PREFIX) :],
                    member.user_id,
                    member.name,
                    text,
                    data.get("reply_to"),
                )
            except _STORE_ERRORS as e:  # told to the author, not raised
                logger.warning("Team chat message not stored: %s", type(e).__name__)
                reason = "unavailable"
            else:
                payload = _event(channel, "chat_message", stored)
                for other in list(self._rooms.get(channel, {})):
                    await _send(other, payload)
                return
        await _send(websocket, _event(channel, "chat_rejected", {"reason": reason}))
