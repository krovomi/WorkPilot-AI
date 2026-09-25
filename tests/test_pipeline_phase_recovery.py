"""A failed planning session must never advance an unfinished build to QA."""

import json
from unittest.mock import AsyncMock, Mock

import pytest


@pytest.fixture
def pipeline(monkeypatch, temp_git_repo):
    from agents import coder

    spec_dir = temp_git_repo / ".workpilot" / "specs" / "001-recovery"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text("# Recovery test\n", encoding="utf-8")

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def provider_name(self):
            return "ollama"

    monkeypatch.setattr(coder, "create_agent_client", lambda *a, **kw: Client())
    monkeypatch.setattr(coder, "get_graphiti_context", AsyncMock(return_value=None))
    monkeypatch.setattr(coder, "load_subtask_context", lambda *a, **kw: {})
    monkeypatch.setattr(coder, "AUTO_CONTINUE_DELAY_SECONDS", 0)
    monkeypatch.setattr(coder, "wait_for_auth_resume", AsyncMock())
    monkeypatch.setattr(coder.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(coder, "_emit_phase_failure", failure := Mock())
    return coder, temp_git_repo, spec_dir, failure


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", ["generic", "rate_limit", "authentication"])
async def test_planning_retries_stay_in_planning(pipeline, monkeypatch, error_type):
    coder, project, spec, _ = pipeline
    from core.build_signals import BuildHalted
    from task_logger import LogPhase

    phases = []

    async def session(*args, phase, **kwargs):
        phases.append(phase)
        return (
            "error",
            "temporary provider failure",
            {"type": error_type, "message": "temporary provider failure"},
        )

    monkeypatch.setattr(coder, "run_agent_session", session)
    try:
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=2)
    except BuildHalted:
        pass
    assert phases == [LogPhase.PLANNING, LogPhase.PLANNING]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "plan",
    [
        None,
        {"phases": []},
        {
            "phases": [
                {
                    "id": "1",
                    "name": "Implementation",
                    "subtasks": [
                        {
                            "id": "1.1",
                            "description": "Unfinished work",
                            "status": "failed",
                        }
                    ],
                }
            ]
        },
    ],
)
async def test_incomplete_build_cannot_return_success(pipeline, monkeypatch, plan):
    coder, project, spec, failure = pipeline
    from core.build_signals import BuildHalted

    if plan is not None:
        (spec / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
    monkeypatch.setattr(
        coder,
        "run_agent_session",
        AsyncMock(
            return_value=(
                "error",
                "provider disconnected",
                {"type": "generic", "message": "provider disconnected"},
            )
        ),
    )
    with pytest.raises(BuildHalted):
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=1)
    failure.assert_called()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "provider", ["ollama", "lmstudio", "openai", "claude", "github_copilot", "windsurf"]
)
async def test_transient_failure_recovers_then_runs_coding(
    pipeline, monkeypatch, provider
):
    coder, project, spec, failure = pipeline
    from task_logger import LogPhase

    (spec / "task_metadata.json").write_text(
        json.dumps({"provider": provider}), encoding="utf-8"
    )
    phases = []
    plan = {
        "feature": "Recovery",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "1",
                "name": "Implementation",
                "subtasks": [
                    {
                        "id": "1.1",
                        "description": "Implement recovery",
                        "status": "pending",
                    }
                ],
            }
        ],
    }

    async def session(*args, phase, **kwargs):
        phases.append(phase)
        if len(phases) == 1:
            return (
                "error",
                "connection interrupted",
                {"type": "generic", "message": "connection interrupted"},
            )
        if phase == LogPhase.CODING:
            plan["phases"][0]["subtasks"][0]["status"] = "completed"
        (spec / "implementation_plan.json").write_text(
            json.dumps(plan), encoding="utf-8"
        )
        return ("complete" if phase == LogPhase.CODING else "continue"), "done", {}

    monkeypatch.setattr(coder, "run_agent_session", session)
    monkeypatch.setattr(coder, "post_session_processing", AsyncMock(return_value=True))
    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)
    assert phases == [LogPhase.PLANNING, LogPhase.PLANNING, LogPhase.CODING]
    failure.assert_not_called()


@pytest.mark.asyncio
async def test_loop_detector_pause_does_not_authorize_qa(pipeline, monkeypatch):
    coder, project, spec, _ = pipeline
    from agents import loop_detection
    from core.build_signals import BuildPaused

    monkeypatch.setattr(loop_detection, "loop_detection_enabled", lambda: True)
    detector = Mock()
    detector.hash_diff.return_value = "unchanged"
    detector.record_and_check.return_value = True
    detector.buffer_snapshot.return_value = []
    monkeypatch.setattr(loop_detection, "get_detector", lambda _: detector)
    monkeypatch.setattr(
        coder,
        "run_agent_session",
        AsyncMock(
            return_value=(
                "error",
                "temporary error",
                {"type": "generic", "message": "temporary error"},
            )
        ),
    )
    with pytest.raises(BuildPaused):
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=2)


@pytest.mark.asyncio
async def test_repeated_planning_error_preserves_terminal_failure(
    pipeline, monkeypatch
):
    coder, project, spec, failure = pipeline
    from core.build_signals import BuildHalted

    session = AsyncMock(
        return_value=(
            "error",
            "local generation timed out",
            {"type": "generic", "message": "local generation timed out"},
        )
    )
    monkeypatch.setattr(coder, "run_agent_session", session)
    with pytest.raises(BuildHalted, match="local generation timed out") as stopped:
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=5)
    assert session.await_count == 3
    assert stopped.value.phase == "planning"
    assert stopped.value.recoverable is False
    failure.assert_called_once()
    assert failure.call_args.kwargs["recoverable"] is False
