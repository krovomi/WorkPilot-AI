"""The shield when a wait is too long, a user resumes, or the disk refuses.

`tests/services/test_rate_limit_shield.py` pins the common paths; these pin
the rest: each marker is best-effort, so a failure to write it never stops
the halt it records.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from services.rate_limit_shield import (
    LOCAL_MODEL_NO_TOOLS_HALT_FILE,
    PROMPT_TOO_LONG_HALT_FILE,
    handle_local_model_no_tools,
    handle_prompt_too_long,
    handle_rate_limit_pause,
)

TOO_LONG = RuntimeError("Anthropic: 400 prompt is too long: 250000 tokens")


@pytest.mark.asyncio
async def test_a_wait_longer_than_the_cap_is_not_taken(tmp_path, caplog):
    later = datetime.now() + timedelta(hours=5)

    with (
        patch(
            "agents.coder.parse_rate_limit_reset_time", return_value=later.timestamp()
        ),
        patch("agents.coder.wait_for_rate_limit_reset") as wait,
    ):
        handled = await handle_rate_limit_pause(
            RuntimeError("429 rate limit reached"), tmp_path, "qa"
        )

    assert handled is False
    wait.assert_not_called()
    assert "wait time too long" in caplog.text


@pytest.mark.asyncio
async def test_a_user_who_resumes_early_is_told_so(tmp_path, capsys):
    soon = datetime.now() + timedelta(minutes=5)

    async def resumed(spec_dir, wait_seconds, source_spec_dir):
        return True

    with (
        patch(
            "agents.coder.parse_rate_limit_reset_time", return_value=soon.timestamp()
        ),
        patch("agents.coder.wait_for_rate_limit_reset", side_effect=resumed),
    ):
        assert await handle_rate_limit_pause(
            RuntimeError("429 rate limit reached"), tmp_path, "coder"
        )

    assert "Resumed early by user" in capsys.readouterr().out


def test_a_log_archive_that_fails_does_not_stop_the_halt(tmp_path, caplog):
    def broken(spec_dir, reason):
        raise OSError("log locked")

    with patch("core.conversation_log.archive_all_logs", side_effect=broken):
        assert handle_prompt_too_long(TOO_LONG, tmp_path, "coder") is True

    assert "Could not archive conversation log(s): log locked" in caplog.text
    assert (tmp_path / PROMPT_TOO_LONG_HALT_FILE).exists()


def test_a_resume_marker_that_cannot_be_moved_is_logged(tmp_path, caplog):
    (tmp_path / ".session.json").write_text("{}", encoding="utf-8")

    def refuse(self, target):
        raise PermissionError("in use")

    with patch.object(Path, "rename", refuse):
        assert handle_prompt_too_long(TOO_LONG, tmp_path, "qa") is True

    assert "Could not archive .session.json: in use" in caplog.text


def test_a_halt_marker_that_cannot_be_written_still_halts(tmp_path, caplog):
    (tmp_path / PROMPT_TOO_LONG_HALT_FILE).mkdir()

    assert handle_prompt_too_long(TOO_LONG, tmp_path, "spec") is True
    assert "Could not write prompt-too-long halt marker" in caplog.text


def test_a_no_tools_marker_that_cannot_be_written_still_halts(tmp_path, caplog):
    (tmp_path / LOCAL_MODEL_NO_TOOLS_HALT_FILE).mkdir()
    client = SimpleNamespace(tool_calling_unsupported=True, model="tiny")

    assert handle_local_model_no_tools(client, tmp_path, "qa") is True
    assert "Could not write local-model-no-tools halt marker" in caplog.text
