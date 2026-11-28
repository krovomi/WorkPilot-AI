"""Bookmarks on a saved replay session (#347).

A bookmark marks one step with a note, so a teammate reading the session (in
the app, or in its export) goes straight to what matters. Only a session that
is no longer recording takes one: the recorder rewrites a live session when it
ends, which would drop the marker.

A bookmark is also where a team discusses a step: each reader can answer its
note (``add_reply``). The replies live in the session file with the
bookmark, so they leave with an export or a team link and come back with an
import, and the next reader answers in turn.
"""

from __future__ import annotations

from .models import Bookmark, BookmarkReply
from .recorder import ReplayRecorder

MAX_NOTE = 4000
MAX_AUTHOR = 100
MAX_BOOKMARKS = 200
MAX_REPLIES = 50


class BookmarkError(ValueError):
    """The bookmark cannot be added: the reason is in ``code``."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def add_bookmark(
    recorder: ReplayRecorder,
    session_id: str,
    step_index: int,
    note: str,
    author: str = "",
) -> Bookmark:
    if recorder.is_recording(session_id):
        raise BookmarkError("recording")
    session = recorder.load_session(session_id)
    if session is None:
        raise BookmarkError("not_found")
    if not any(step.step_index == step_index for step in session.steps):
        raise BookmarkError("no_such_step")
    if len(session.bookmarks) >= MAX_BOOKMARKS:
        raise BookmarkError("too_many")
    bookmark = Bookmark(
        step_index=step_index,
        note=note.strip()[:MAX_NOTE],
        author=author.strip()[:MAX_AUTHOR],
    )
    session.bookmarks.append(bookmark)
    session.bookmarks.sort(key=lambda b: (b.step_index, b.created_at))
    recorder.save_session(session)
    return bookmark


def remove_bookmark(
    recorder: ReplayRecorder, session_id: str, bookmark_id: str
) -> bool:
    if recorder.is_recording(session_id):
        return False
    session = recorder.load_session(session_id)
    if session is None:
        return False
    kept = [b for b in session.bookmarks if b.id != bookmark_id]
    if len(kept) == len(session.bookmarks):
        return False
    session.bookmarks = kept
    recorder.save_session(session)
    return True


def _saved_session(recorder: ReplayRecorder, session_id: str):
    if recorder.is_recording(session_id):
        raise BookmarkError("recording")
    session = recorder.load_session(session_id)
    if session is None:
        raise BookmarkError("not_found")
    return session


def add_reply(
    recorder: ReplayRecorder,
    session_id: str,
    bookmark_id: str,
    note: str,
    author: str = "",
) -> BookmarkReply:
    """Answer a bookmark's note, after the replies already there."""
    text = note.strip()[:MAX_NOTE]
    if not text:
        raise BookmarkError("empty_reply")
    session = _saved_session(recorder, session_id)
    bookmark = next((b for b in session.bookmarks if b.id == bookmark_id), None)
    if bookmark is None:
        raise BookmarkError("no_such_bookmark")
    if len(bookmark.replies) >= MAX_REPLIES:
        raise BookmarkError("too_many_replies")
    reply = BookmarkReply(note=text, author=author.strip()[:MAX_AUTHOR])
    bookmark.replies.append(reply)
    recorder.save_session(session)
    return reply


def remove_reply(
    recorder: ReplayRecorder, session_id: str, bookmark_id: str, reply_id: str
) -> bool:
    try:
        session = _saved_session(recorder, session_id)
    except BookmarkError:
        return False
    bookmark = next((b for b in session.bookmarks if b.id == bookmark_id), None)
    if bookmark is None:
        return False
    kept = [r for r in bookmark.replies if r.id != reply_id]
    if len(kept) == len(bookmark.replies):
        return False
    bookmark.replies = kept
    recorder.save_session(session)
    return True
