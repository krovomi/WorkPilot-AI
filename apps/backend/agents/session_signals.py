"""What a session's ending says when the stream itself ended cleanly.

A provider does not always raise when a call fails. The Claude CLI answers an
expired or revoked sign-in with an ordinary assistant message, written by the
CLI rather than the model and costing zero tokens::

    Failed to authenticate. API Error: 401 {"type":"error","error":
    {"type":"authentication_error","message":"OAuth access token has expired.
    Re-authenticate to continue."}}

The stream then ends like any other turn, so the session loop returned
``continue`` with that sentence as the model's answer. In planning it was read
as a plan that failed validation; three of them in a row became "the model did
not produce a valid implementation_plan.json (unparseable or missing
`phases`)", while the account, not the model, was the problem. An earlier
skill phase (``brainstorm``) saved the same sentence as its report, and the
planner was handed it as one.

`auth_failure_in_turn` names that case so both session runners can return the
``authentication`` error the exception path already returns: the coder then
pauses for a new sign-in (``AUTH_PAUSE``), which is also what starts the
automatic failover to the next account.

`break_replay_channels` is the cleanup a blown context window needs, written
once instead of three times in ``agents.session``.
"""

from __future__ import annotations

import logging
import os
import re
from datetime import datetime
from pathlib import Path

from .provider_errors import is_authentication_error

logger = logging.getLogger(__name__)

__all__ = [
    "auth_failure_in_turn",
    "break_replay_channels",
    "is_auth_failure_echo",
]

# A CLI's own sign-in refusal is short: the sentence, sometimes the API's JSON
# error body. A model's answer that merely mentions one of these words is
# prose, and much longer than this.
_ECHO_MAX_CHARS = 600

# How such a refusal begins. Anchored at the start on purpose: a coder's
# summary "Fixed the Invalid API key message" must never pause a build.
_ECHO_START = re.compile(
    r"^(?:"
    r"failed to authenticate"
    r"|api error:?\s*401\b"
    r"|invalid api key"
    r"|oauth (?:access )?token (?:has )?(?:expired|revoked|is invalid)"
    r"|please run /login"
    r"|not logged in"
    r"|authentication_error"
    r"|authentication failed"
    r")",
    re.IGNORECASE,
)

# A status line is the client talking about itself (heartbeats included, which
# can read "401 tokens"). Only a line that reports an error or a failure is
# asked whether it is a sign-in refusal.
_ERROR_LINE = re.compile(r"error|fail", re.IGNORECASE)


def is_auth_failure_echo(text: str | None) -> bool:
    """Is this whole answer a sign-in refusal rather than model output?"""
    stripped = (text or "").strip()
    if not stripped or len(stripped) > _ECHO_MAX_CHARS:
        return False
    return bool(_ECHO_START.match(stripped))


def auth_failure_in_turn(
    response_text: str | None, status_text: str = ""
) -> str | None:
    """The sign-in refusal a turn ended on, or ``None``.

    The model's answer is checked first. A client's status lines count only
    when the turn produced no answer at all: a status line beside real work
    is a notice, not the outcome of the turn.
    """
    if is_auth_failure_echo(response_text):
        return (response_text or "").strip()
    if (response_text or "").strip():
        return None
    for line in (status_text or "").splitlines():
        line = line.strip()
        if (
            line
            and _ERROR_LINE.search(line)
            and is_authentication_error(RuntimeError(line))
        ):
            return line
    return None


def break_replay_channels(spec_dir: Path) -> int:
    """Stop the next session from replaying a transcript that blew the window.

    Three channels carry it: the conversation logs (replayed by
    ``agents.session._maybe_replay_conversation``), the SDK's ``.session.json``
    resume pointer and the in-process ``AUTO_CLAUDE_RESUME_SESSION_ID``. All
    three are cleared, or the same prompt trips the same wall. Returns how many
    logs were archived. Never raises: archiving is housekeeping and must not
    hide the error that called for it.
    """
    from core.conversation_log import archive_all_logs

    moved = 0
    try:
        moved = archive_all_logs(spec_dir, "too-long")
        if moved:
            logger.info("[session] Archived %d oversized conversation log(s)", moved)
        state = spec_dir / ".session.json"
        if state.exists():
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            state.rename(spec_dir / f".session.{stamp}.too-long.json")
        os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
    except OSError as exc:
        logger.warning("[session] Could not archive oversized session state: %s", exc)
    return moved
