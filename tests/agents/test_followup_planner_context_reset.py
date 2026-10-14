"""The follow-up planner stops cutting its planning after a few resets in a row.

Its loop re-runs planning on every "context_reset". A thread that is full from
its first turns would otherwise re-run it forever.
"""

import importlib
import json

import pytest


@pytest.mark.asyncio
async def test_followup_planning_runs_monitor_only_once_the_budget_is_spent(
    monkeypatch, temp_git_repo
):
    from agents import planner
    from context_mgmt.resets import MAX_CONSECUTIVE_RESETS

    spec = temp_git_repo / ".workpilot" / "specs" / "001-followup"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Follow-up\n", encoding="utf-8")
    (spec / "FOLLOWUP_REQUEST.md").write_text("Add a flag\n", encoding="utf-8")
    plan = {
        "feature": "Follow-up",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "1",
                "name": "Implementation",
                "subtasks": [
                    {"id": "1.1", "description": "Old work", "status": "completed"},
                    {"id": "2.1", "description": "New work", "status": "pending"},
                ],
            }
        ],
    }
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

    calls: list[bool] = []

    async def session(*args, **kwargs):
        monitor_only = kwargs.get("context_monitor_only", False)
        calls.append(monitor_only)
        if len(calls) > MAX_CONSECUTIVE_RESETS + 1:
            # Fail fast instead of hanging if the loop ever stops capping.
            raise RuntimeError("follow-up planning looped on context resets")
        if not monitor_only:
            return "context_reset", "", {"context_reset": True, "action": "clear"}
        return "continue", "planned", {}

    monkeypatch.setattr(planner, "_create_planning_client", lambda *a, **kw: Client())
    monkeypatch.setattr(planner, "run_agent_session", session)
    # The module the planner will import, whatever an earlier test left in
    # sys.modules under that name.
    prompts = importlib.import_module("prompts_pkg.prompts")
    monkeypatch.setattr(prompts, "get_followup_planner_prompt", lambda _spec: "plan it")

    await planner.run_followup_planner(temp_git_repo, spec, "test-model")

    assert calls == [False] * MAX_CONSECUTIVE_RESETS + [True]
