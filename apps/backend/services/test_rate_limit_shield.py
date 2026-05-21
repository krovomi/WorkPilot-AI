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
