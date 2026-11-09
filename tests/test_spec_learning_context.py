"""The spec writer and its critic receive the Learning Loop's lessons (#345).

`learning_loop.prompt_injection.context_for_agent` maps both onto the
`planning` phase; before this, nothing under `spec/` asked for them.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from spec.phases import PhaseExecutor
from spec.phases.spec_phases import learning_context_for

LESSONS = "## Learned from previous builds\n- Use the repository's Result<T> type"


def _lessons(_project_dir, agent_type, task_context=None):
    return f"{LESSONS} ({agent_type})"


def _executor(temp_dir: Path, spec_dir: Path, agent_fn, validator, logger, ui):
    return PhaseExecutor(
        project_dir=temp_dir,
        spec_dir=spec_dir,
        task_description="Add a refund endpoint",
        spec_validator=validator,
        run_agent_fn=agent_fn,
        task_logger=logger,
        ui_module=ui,
    )


def test_no_lessons_add_nothing(temp_dir: Path):
    with patch("learning_loop.prompt_injection.context_for_agent", return_value=""):
        assert learning_context_for(temp_dir, "spec_writer") == ""


def test_lessons_come_as_their_own_block(temp_dir: Path):
    with patch("learning_loop.prompt_injection.context_for_agent", _lessons):
        assert learning_context_for(temp_dir, "spec_writer") == (
            f"\n\n{LESSONS} (spec_writer)"
        )


@pytest.mark.asyncio
async def test_quick_spec_gets_the_spec_writers_lessons(
    temp_dir: Path,
    spec_dir: Path,
    mock_task_logger,
    mock_ui_module,
    mock_spec_validator,
):
    async def writes_spec(*_args, **_kwargs):
        (spec_dir / "spec.md").write_text("# Spec", encoding="utf-8")
        (spec_dir / "implementation_plan.json").write_text(
            json.dumps({"phases": []}), encoding="utf-8"
        )
        return True, "done"

    agent_fn = AsyncMock(side_effect=writes_spec)
    executor = _executor(
        temp_dir,
        spec_dir,
        agent_fn,
        mock_spec_validator(),
        mock_task_logger,
        mock_ui_module,
    )
    with patch("learning_loop.prompt_injection.context_for_agent", _lessons):
        await executor.phase_quick_spec()

    assert agent_fn.await_args.args[0] == "spec_quick.md"
    assert (
        f"{LESSONS} (spec_writer)" in agent_fn.await_args.kwargs["additional_context"]
    )


@pytest.mark.asyncio
async def test_spec_writing_gets_the_spec_writers_lessons(
    temp_dir: Path,
    spec_dir: Path,
    mock_task_logger,
    mock_ui_module,
    mock_spec_validator,
):
    async def writes_spec(*_args, **_kwargs):
        (spec_dir / "spec.md").write_text("# Spec", encoding="utf-8")
        return True, "done"

    agent_fn = AsyncMock(side_effect=writes_spec)
    executor = _executor(
        temp_dir,
        spec_dir,
        agent_fn,
        mock_spec_validator(),
        mock_task_logger,
        mock_ui_module,
    )
    with patch("learning_loop.prompt_injection.context_for_agent", _lessons):
        result = await executor.phase_spec_writing()

    assert result.success is True
    assert agent_fn.await_args.args[0] == "spec_writer.md"
    assert agent_fn.await_args.kwargs["additional_context"].endswith(
        f"{LESSONS} (spec_writer)"
    )


@pytest.mark.asyncio
async def test_self_critique_gets_the_critics_lessons(
    temp_dir: Path,
    spec_dir: Path,
    mock_task_logger,
    mock_ui_module,
    mock_spec_validator,
):
    (spec_dir / "spec.md").write_text("# Spec", encoding="utf-8")

    async def critiques(*_args, **_kwargs):
        (spec_dir / "critique_report.json").write_text(
            json.dumps({"issues_found": [], "no_issues_found": True}),
            encoding="utf-8",
        )
        return True, "done"

    agent_fn = AsyncMock(side_effect=critiques)
    executor = _executor(
        temp_dir,
        spec_dir,
        agent_fn,
        mock_spec_validator(),
        mock_task_logger,
        mock_ui_module,
    )
    with patch("learning_loop.prompt_injection.context_for_agent", _lessons):
        await executor.phase_self_critique()

    assert agent_fn.await_args.args[0] == "spec_critic.md"
    assert agent_fn.await_args.kwargs["additional_context"].endswith(
        f"{LESSONS} (spec_self_critique)"
    )
