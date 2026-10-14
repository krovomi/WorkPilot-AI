"""Apply a compact or a clear to a task's conversation state.

Both leave the next session to rebuild its client, exactly like a hot swap:
what changes is what that session replays.

* **clear** closes every live thread (all models' logs archived as
  ``.cleared.``), forgets the Claude SDK resume pointer — the three layers
  ``services/rate_limit_shield.handle_prompt_too_long`` documents — and leaves
  a handoff note the next session starts from.
* **compact** rewrites this model's log as a summary plus the last turns of
  the phase; the next session replays that instead of the whole history.
"""

from __future__ import annotations

import logging
import os
from datetime import datetime
from pathlib import Path

from .handoff import write_pending_handoff

logger = logging.getLogger(__name__)


def _forget_resume_pointer(spec_dir: Path, tag: str) -> None:
    os.environ.pop("AUTO_CLAUDE_RESUME_SESSION_ID", None)
    marker = spec_dir / ".session.json"
    if marker.exists():
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        try:
            marker.rename(spec_dir / f".session.{stamp}.{tag}.json")
        except OSError as exc:
            logger.debug("[context] could not archive .session.json: %s", exc)


def apply_clear(spec_dir: Path, handoff: str) -> int:
    """Close the thread; the next session starts from ``handoff``. Never raises."""
    moved = 0
    try:
        from core.conversation_log import archive_all_logs

        moved = archive_all_logs(spec_dir, "cleared")
    except Exception as exc:  # noqa: BLE001
        logger.warning("[context] could not archive conversation logs: %s", exc)
    _forget_resume_pointer(spec_dir, "cleared")
    write_pending_handoff(spec_dir, handoff)
    return moved


def apply_compact(
    spec_dir: Path,
    *,
    provider: str | None,
    model: str | None,
    phase: str,
    summary: str,
    subtask_id: str | None = None,
    keep_tail: int = 8,
) -> bool:
    """Replace this model's history by ``summary`` + its last turns. Never raises."""
    try:
        from core.conversation_log import replace_with_summary

        done = replace_with_summary(
            spec_dir,
            provider,
            model,
            phase=phase,
            summary=summary,
            keep_tail=keep_tail,
            subtask_id=subtask_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("[context] compaction failed: %s", exc)
        done = False
    _forget_resume_pointer(spec_dir, "compacted")
    return done
