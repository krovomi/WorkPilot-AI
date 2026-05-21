"""
Rate-limit shield: pause-and-resume on Anthropic 429 errors.

Generic helper that any LLM-calling phase (coder, qa, planner, spec, PR reviewer,
auto-fix, ...) can use to ride out a rate-limit window without counting the
error against retry budgets and without escalating to human review prematurely.

The coder phase originally owned this logic; QA reimplemented part of it; spec
and PR review phases had nothing. This module centralises it so every phase
gets the same behavior and one bug fix lands everywhere at once.

Imports of `agents.*` are deferred to the call site so that test modules which
mock out the `agents` package can still import the helper.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)


async def handle_rate_limit_pause(
    error: Exception,
    spec_dir: Path,
    phase: str,
    source_spec_dir: Path | None = None,
) -> bool:
    """
    Detect a rate-limit error and, if recognised, pause until the quota window
    resets (or until the user manually resumes via the frontend).

    Args:
        error: The exception raised by the LLM session
        spec_dir: Spec directory where the pause file should be written (typically
            the worktree spec dir so the frontend can detect it)
        phase: Short tag describing the calling phase ("coder", "qa", "planner",
            "spec", "auto_fix", "pr_review"). Written into the pause file so the
            UI can show "Paused during QA" etc.
        source_spec_dir: Optional main-project spec dir used as a fallback for
            the RESUME signal when the worktree is hard to locate from the UI.

    Returns:
        True  — error was a rate-limit AND we paused-then-resumed. The caller
                should retry without incrementing any error counter.
        False — error was not a rate-limit, OR the wait time couldn't be parsed,
                OR the wait was unreasonably long (>MAX_RATE_LIMIT_WAIT_SECONDS).
                The caller should fall back to its usual error path.
    """
    from agents.base import MAX_RATE_LIMIT_WAIT_SECONDS, RATE_LIMIT_PAUSE_FILE
    from agents.coder import parse_rate_limit_reset_time, wait_for_rate_limit_reset
    from agents.session import is_rate_limit_error

    if not is_rate_limit_error(error):
        return False

    error_info = {"message": str(error), "type": "rate_limit"}
    reset_timestamp = parse_rate_limit_reset_time(error_info)

    if not reset_timestamp:
        logger.warning(
            "[%s] Rate limit hit but reset time could not be parsed — "
            "falling back to standard error handling",
            phase,
        )
        return False

    wait_seconds = reset_timestamp - datetime.now().timestamp()
    if wait_seconds <= 0:
        logger.info("[%s] Rate limit already reset, retrying immediately", phase)
        return True
    if wait_seconds > MAX_RATE_LIMIT_WAIT_SECONDS:
        logger.error(
            "[%s] Rate limit wait time too long (%.1fh) — giving up rather than waiting",
            phase,
            wait_seconds / 3600,
        )
        return False

    wait_minutes = wait_seconds / 60
    logger.warning(
        "[%s] Rate limit hit — pausing for %.0f minutes (reset_ts=%s)",
        phase,
        wait_minutes,
        reset_timestamp,
    )
    print(f"\n⏸  Rate limit reached. Pausing {phase} for {wait_minutes:.0f} minutes...")

    pause_data = {
        "paused_at": datetime.now().isoformat(),
        "reset_timestamp": reset_timestamp,
        "error": str(error)[:500],
        "phase": phase,
    }
    pause_file = spec_dir / RATE_LIMIT_PAUSE_FILE
    pause_file.write_text(json.dumps(pause_data), encoding="utf-8")

    resumed_early = await wait_for_rate_limit_reset(
        spec_dir, wait_seconds, source_spec_dir
    )
    if resumed_early:
        print("▶  Resumed early by user")
    else:
        print(f"▶  Rate limit window elapsed, resuming {phase}")

    return True
