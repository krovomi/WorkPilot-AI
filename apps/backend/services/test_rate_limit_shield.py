"""Tests for the shared rate-limit shield."""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_returns_false_for_non_rate_limit_error(tmp_path: Path) -> None:
    """Generic exceptions must NOT be swallowed — the caller still needs to
    count them as errors."""
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("internal server error 500")
    handled = await handle_rate_limit_pause(err, tmp_path, "qa")
    assert handled is False


@pytest.mark.asyncio
async def test_pauses_and_resumes_on_429_with_relative_time(tmp_path: Path) -> None:
    """A 429 with a parseable reset time must (1) be detected, (2) write a
    pause file with the calling phase tag, (3) wait, (4) return True."""
    from agents.base import RATE_LIMIT_PAUSE_FILE
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("429 rate_limit_error: please retry in 1 minute")

    async def fake_wait(spec_dir, wait_seconds, source_spec_dir):
        return False  # waited full duration

    with patch("agents.coder.wait_for_rate_limit_reset", side_effect=fake_wait):
        handled = await handle_rate_limit_pause(err, tmp_path, "auto_fix")

    assert handled is True
    pause_file = tmp_path / RATE_LIMIT_PAUSE_FILE
    assert pause_file.exists()
    content = pause_file.read_text(encoding="utf-8")
    assert '"phase": "auto_fix"' in content, (
        "pause file must record which phase paused so the UI can show it"
    )


@pytest.mark.asyncio
async def test_falls_back_when_reset_time_unparseable(tmp_path: Path) -> None:
    """If the rate-limit message has no parseable reset time, return False so
    the caller falls back to its normal error-counting path rather than
    deadlocking on a wait with no end."""
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("429 rate_limit_error")
    handled = await handle_rate_limit_pause(err, tmp_path, "spec")
    assert handled is False


@pytest.mark.asyncio
async def test_skips_wait_when_reset_already_passed(tmp_path: Path) -> None:
    """When the parsed reset is in the past, retry immediately rather than
    calling wait_for_rate_limit_reset with a negative duration."""
    from services.rate_limit_shield import handle_rate_limit_pause

    past = datetime.now() - timedelta(minutes=2)

    with (
        patch(
            "agents.coder.parse_rate_limit_reset_time",
            return_value=past.timestamp(),
        ),
        patch("agents.coder.wait_for_rate_limit_reset") as wait_mock,
    ):
        handled = await handle_rate_limit_pause(
            RuntimeError("429 rate limit reached"), tmp_path, "planner"
        )

    assert handled is True
    wait_mock.assert_not_called()


@pytest.mark.asyncio
async def test_phase_tag_appears_in_pause_file(tmp_path: Path) -> None:
    """Different phases pausing produces different `phase` field — verify the
    tag is passed through verbatim so the frontend can render it."""
    from agents.base import RATE_LIMIT_PAUSE_FILE
    from services.rate_limit_shield import handle_rate_limit_pause

    err = RuntimeError("429 rate_limit_error: please retry in 2 minutes")

    async def fake_wait(spec_dir, wait_seconds, source_spec_dir):
        return False

    with patch("agents.coder.wait_for_rate_limit_reset", side_effect=fake_wait):
        await handle_rate_limit_pause(err, tmp_path, "spec:requirements")

    content = (tmp_path / RATE_LIMIT_PAUSE_FILE).read_text(encoding="utf-8")
    assert "spec:requirements" in content


@pytest.mark.asyncio
async def test_qa_loop_wrapper_still_works(tmp_path: Path) -> None:
    """The legacy `_handle_rate_limit_in_qa` wrapper in qa.loop must still
    work — it's a public-ish surface that other tests and the actual QA loop
    still depend on. It must delegate to the shared shield with phase='qa'."""
    from agents.base import RATE_LIMIT_PAUSE_FILE
    from qa.loop import _handle_rate_limit_in_qa

    err = RuntimeError("429 rate_limit_error: please retry in 1 minute")

    async def fake_wait(spec_dir, wait_seconds, source_spec_dir):
        return False

    with patch("agents.coder.wait_for_rate_limit_reset", side_effect=fake_wait):
        handled = await _handle_rate_limit_in_qa(err, tmp_path, None)

    assert handled is True
    content = (tmp_path / RATE_LIMIT_PAUSE_FILE).read_text(encoding="utf-8")
    assert '"phase": "qa"' in content


# ---------------------------------------------------------------------------
# handle_prompt_too_long — permanent halt path (different from rate-limit which
# is a temporary pause-and-resume). These errors come from the LLM saying
# "your conversation exceeds my context window" — retrying with the same
# transcript will fail identically.
# ---------------------------------------------------------------------------


def test_prompt_too_long_returns_false_for_other_errors(tmp_path: Path) -> None:
    """Non-prompt-too-long errors must NOT trigger the halt path — the caller
    should fall through to its normal error handling."""
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    assert handle_prompt_too_long(RuntimeError("boom"), tmp_path, "qa") is False
    assert (
        handle_prompt_too_long(RuntimeError("429 rate limit"), tmp_path, "coder")
        is False
    )
    # No marker file should have been written.
    assert not (tmp_path / PROMPT_TOO_LONG_HALT_FILE).exists()


def test_prompt_too_long_writes_halt_marker_and_returns_true(tmp_path: Path) -> None:
    """When the LLM says the prompt is too long, the helper must write the
    halt marker file and return True so the caller knows to stop retrying."""
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    err = RuntimeError("Anthropic: 400 prompt is too long: 250000 tokens")
    handled = handle_prompt_too_long(err, tmp_path, "coder")

    assert handled is True
    marker = tmp_path / PROMPT_TOO_LONG_HALT_FILE
    assert marker.exists()
    content = marker.read_text(encoding="utf-8")
    assert '"phase": "coder"' in content
    assert "Reset the conversation" in content


def test_prompt_too_long_marker_records_phase_tag(tmp_path: Path) -> None:
    """The phase tag in the marker lets the UI tell the user where the halt
    happened ('Halted during QA' vs 'Halted during planning')."""
    from services.rate_limit_shield import (
        PROMPT_TOO_LONG_HALT_FILE,
        handle_prompt_too_long,
    )

    err = RuntimeError("context_length_exceeded")
    handle_prompt_too_long(err, tmp_path, "auto_fix")

    content = (tmp_path / PROMPT_TOO_LONG_HALT_FILE).read_text(encoding="utf-8")
    assert '"phase": "auto_fix"' in content


def test_prompt_too_long_detects_various_message_shapes(tmp_path: Path) -> None:
    """The helper should recognise the common phrasings used by Anthropic,
    OpenAI, and other providers — not just one exact string."""
    from services.rate_limit_shield import handle_prompt_too_long

    samples = [
        "Prompt is too long",
        "prompt too long",
        "context length exceeded",
        "maximum context length exceeded for model X",
        "input is too long",
    ]
    for msg in samples:
        # Each call uses a fresh tmp dir via a unique sub-path to avoid the
        # marker from a previous iteration tainting the result.
        sub = tmp_path / f"sub_{hash(msg)}"
        sub.mkdir()
        assert handle_prompt_too_long(RuntimeError(msg), sub, "qa") is True, (
            f"should have matched: {msg!r}"
        )
