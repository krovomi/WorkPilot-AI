import asyncio
from pathlib import Path

from integrations.jev.adapters import ReviewInput, assess_build, assess_review
from integrations.jev.models import JevContext
from integrations.jev.runtime import JevRun


def test_disabled_does_not_read_project(tmp_path, monkeypatch):
    run = JevRun.from_env(JevContext("feature-build", tmp_path, tmp_path), env={})
    monkeypatch.setattr(
        Path, "read_text", lambda *a, **k: (_ for _ in ()).throw(AssertionError("read"))
    )
    result = asyncio.run(assess_build(run, "classification", pass_id="plan"))
    assert result.reason == "disabled"


def test_missing_context_is_optional(tmp_path):
    run = JevRun.from_env(
        JevContext("feature-build", tmp_path, tmp_path),
        env={"WORKPILOT_JEV_ENABLED": "1", "TYPESAFE_API_KEY": "fake"},
    )
    result = asyncio.run(assess_build(run, "classification", pass_id="plan"))
    assert result.reason == "missing_context"


def test_review_bypass_is_recorded_once(tmp_path):
    run = JevRun.from_env(JevContext("github-review", tmp_path), env={})
    result = asyncio.run(
        assess_review(run, ReviewInput("title", "body", [], "", "head"))
    )
    assert result.reason == "disabled"
    assert len(run.observation["evaluations"]) == 1
