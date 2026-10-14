"""A session the context guard closes must not hide the work it finished.

`run_agent_session` returns "context_reset" when the guard compacts or clears
the thread at a safe point. The coder loop then re-runs the subtask without
post-session processing — right for unfinished work, wrong once the agent had
already marked the subtask completed: the worktree plan never reached the main
project's copy the Kanban reads, and on the last subtask ALL_SUBTASKS_DONE was
never emitted, so the card stayed short of 100%.
"""

import json
from unittest.mock import AsyncMock, Mock

import pytest


def _plan(status: str = "pending") -> dict:
    return {
        "feature": "Context reset",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "1",
                "name": "Implementation",
                "subtasks": [
                    {"id": "1.1", "description": "Do the work", "status": status}
                ],
            }
        ],
    }


@pytest.fixture
def coder_loop(monkeypatch, temp_git_repo):
    from agents import coder

    spec_dir = temp_git_repo / ".workpilot" / "specs" / "001-context-reset"
    spec_dir.mkdir(parents=True)
    (spec_dir / "spec.md").write_text("# Context reset\n", encoding="utf-8")
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(_plan()), encoding="utf-8"
    )

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def provider_name(self):
            return "claude"

    emitted: list[str] = []

    class Emitter:
        def emit(self, event_type, payload=None):
            emitted.append(event_type)

    monkeypatch.setattr(coder, "create_agent_client", lambda *a, **kw: Client())
    monkeypatch.setattr(coder, "get_memory_context", AsyncMock(return_value=None))
    monkeypatch.setattr(coder, "load_subtask_context", lambda *a, **kw: {})
    monkeypatch.setattr(coder, "AUTO_CONTINUE_DELAY_SECONDS", 0)
    monkeypatch.setattr(coder, "wait_for_auth_resume", AsyncMock())
    monkeypatch.setattr(coder.asyncio, "sleep", AsyncMock())
    monkeypatch.setattr(coder, "_emit_phase_failure", Mock())
    monkeypatch.setattr(
        coder.TaskEventEmitter, "from_spec_dir", classmethod(lambda cls, _d: Emitter())
    )
    post = AsyncMock(return_value=True)
    monkeypatch.setattr(coder, "post_session_processing", post)
    return coder, temp_git_repo, spec_dir, post, emitted


def _write_plan(spec_dir, status: str) -> None:
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(_plan(status)), encoding="utf-8"
    )


@pytest.mark.asyncio
async def test_reset_after_the_subtask_is_done_still_finishes_it(
    coder_loop, monkeypatch
):
    coder, project, spec, post, emitted = coder_loop
    calls = []

    async def session(*args, **kwargs):
        calls.append(kwargs.get("phase"))
        # The agent marked its subtask completed, then the guard closed the
        # thread at the next safe point.
        _write_plan(spec, "completed")
        return "context_reset", "", {"context_reset": True, "action": "clear"}

    monkeypatch.setattr(coder, "run_agent_session", session)
    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert len(calls) == 1
    post.assert_awaited_once()
    assert post.await_args.kwargs["subtask_id"] == "1.1"
    assert "ALL_SUBTASKS_DONE" in emitted


@pytest.mark.asyncio
async def test_reset_before_the_subtask_is_done_reruns_it(coder_loop, monkeypatch):
    coder, project, spec, post, emitted = coder_loop
    calls = []

    async def session(*args, **kwargs):
        calls.append(kwargs.get("phase"))
        if len(calls) == 1:
            # Closed mid-work: nothing to process, same subtask again.
            return "context_reset", "", {"context_reset": True, "action": "compact"}
        _write_plan(spec, "completed")
        return "complete", "done", {}

    monkeypatch.setattr(coder, "run_agent_session", session)
    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert len(calls) == 2
    post.assert_awaited_once()
    assert post.await_args.kwargs["subtask_id"] == "1.1"
    assert "ALL_SUBTASKS_DONE" in emitted
