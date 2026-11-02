"""The team chat of a server project: what a message may be, storing it, and
reading the latest ones back.

Members write from the app over the project's stream
(``streaming/project_room.py``), which checks who may write before calling
here. A message is plain text: the app shows it as text, never as markup.
"""

from __future__ import annotations

import re
from datetime import UTC
from typing import Any

from server.db.engine import get_session_factory
from server.db.models import TeamChatMessage
from sqlalchemy import select

#: The longest message, in characters.
MAX_MESSAGE = 2000
#: How many of the latest messages a member receives on joining.
HISTORY = 100
_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
# Control characters other than the line break and the tab.
_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")


def clean_message(raw: Any) -> str | None:
    """The message as stored, or None when it is not one: not text, empty, too long."""
    if not isinstance(raw, str):
        return None
    text = _CONTROL.sub("", raw).strip()
    if not text or len(text) > MAX_MESSAGE:
        return None
    return text


def to_public(row: TeamChatMessage) -> dict[str, Any]:
    created = row.created_at
    if created.tzinfo is None:  # SQLite gives naive datetimes back
        created = created.replace(tzinfo=UTC)
    return {
        "id": row.id,
        "author_id": row.user_id or "",
        "author": row.author_name,
        "message": row.body,
        "reply_to": row.reply_to or "",
        "at": created.isoformat(),
    }


async def save_message(
    project_id: str,
    user_id: str,
    author: str,
    text: str,
    reply_to: Any = None,
) -> dict[str, Any]:
    """Store a cleaned message; a reply to a message of another project is dropped."""
    async with get_session_factory()() as db:
        parent = None
        if isinstance(reply_to, str) and _ID.match(reply_to):
            parent = await db.scalar(
                select(TeamChatMessage.id).where(
                    TeamChatMessage.id == reply_to,
                    TeamChatMessage.project_id == project_id,
                )
            )
        row = TeamChatMessage(
            project_id=project_id,
            user_id=user_id,
            author_name=(author or "").strip()[:200] or "?",
            body=text,
            reply_to=parent,
        )
        db.add(row)
        await db.commit()
        await db.refresh(row)
        return to_public(row)


async def recent_messages(
    project_id: str, limit: int = HISTORY
) -> list[dict[str, Any]]:
    """The latest messages of the project, oldest first."""
    async with get_session_factory()() as db:
        rows = (
            await db.scalars(
                select(TeamChatMessage)
                .where(TeamChatMessage.project_id == project_id)
                .order_by(TeamChatMessage.created_at.desc(), TeamChatMessage.id.desc())
                .limit(limit)
            )
        ).all()
    return [to_public(row) for row in reversed(rows)]
