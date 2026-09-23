import asyncio
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from integrations.jev.adapters import assess_build, capture_base
from integrations.jev.models import JevContext, JevOutcome
from integrations.jev.runtime import JevRun
from spec.phases.executor import PhaseExecutor


def test_spec_planning_evaluates_before_script_without_env_key(tmp_path, monkeypatch):
    monkeypatch.setenv("TYPESAFE_API_KEY", "private-jev")
    monkeypatch.setenv("WORKPILOT_JEV_ENABLED", "1")
    run = JevRun.from_env(JevContext("feature-build", tmp_path, tmp_path))
    run.evaluate = AsyncMock(return_value=JevOutcome("evaluated"))
    (tmp_path / "spec.md").write_text("Implement the feature", encoding="utf-8")
    validator = MagicMock()
    validator.validate_implementation_plan.return_value.valid = True
    executor = PhaseExecutor(
        tmp_path,
        tmp_path,
        "request",
        validator,
        AsyncMock(),
        MagicMock(),
        MagicMock(),
        jev_run=run,
    )

    def script(*args):
        assert "TYPESAFE_API_KEY" not in os.environ
        assert run.evaluate.await_count == 1
        (tmp_path / "implementation_plan.json").write_text(
            '{"phases":[]}', encoding="utf-8"
        )
        return True, ""

    monkeypatch.setattr(executor, "_run_script", script)
    assert asyncio.run(executor.phase_planning()).success
    assert run.has_credential


def test_quick_spec_gets_classification_advice(tmp_path):
    run = JevRun.from_env(
        JevContext("feature-build", tmp_path, tmp_path),
        env={"WORKPILOT_JEV_ENABLED": "1", "TYPESAFE_API_KEY": "fake"},
    )
    run.evaluate = AsyncMock(return_value=JevOutcome("evaluated"))

    async def agent(*args, **kwargs):
        assert run.evaluate.await_count == 1
        assert "Optional JEV assessment" in kwargs["additional_context"]
        (tmp_path / "spec.md").write_text("spec", encoding="utf-8")
        (tmp_path / "implementation_plan.json").write_text(
            '{"phases":[]}', encoding="utf-8"
        )
        return True, ""

    executor = PhaseExecutor(
        tmp_path,
        tmp_path,
        "new task",
        MagicMock(),
        agent,
        MagicMock(),
        MagicMock(),
        jev_run=run,
    )
    assert asyncio.run(executor.phase_quick_spec()).success


def test_direct_build_reviews_committed_changes(tmp_path):
    def git(*args):
        return subprocess.run(
            ["git", "-C", str(tmp_path), *args], check=True, capture_output=True
        )

    git("init")
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "JEV test")
    (tmp_path / "app.py").write_text("old\n", encoding="utf-8")
    git("add", ".")
    git("commit", "-m", "initial")
    spec = tmp_path / "spec"
    spec.mkdir()
    (spec / "spec.md").write_text("Update app", encoding="utf-8")
    run = JevRun.from_env(
        JevContext("feature-build", tmp_path, spec),
        env={"WORKPILOT_JEV_ENABLED": "1", "TYPESAFE_API_KEY": "fake"},
    )
    capture_base(run)
    original = run.base_revision
    (tmp_path / "app.py").write_text("new\n", encoding="utf-8")
    git("add", "app.py")
    git("commit", "-m", "change")
    run.evaluate = AsyncMock(return_value=JevOutcome("evaluated"))
    asyncio.run(assess_build(run, "review", pass_id="qa-1"))
    assert run.base_revision == original
    assert "+new" in run.evaluate.call_args.kwargs["state"]["diff"]
