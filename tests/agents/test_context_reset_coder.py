"""The coder loop stops resetting a subtask that a reset cannot help.

On a model whose window barely holds a fresh coder thread (Ollama or LM Studio
with an 8k-16k ``num_ctx``), the context guard cuts every session at its first
safe point: ``run_agent_session`` returns ``"context_reset"``, the loop re-runs
the same subtask, and the Kanban card never moves. Past
``MAX_CONSECUTIVE_RESETS`` in a row, the rest of the subtask runs with a guard
that only measures.

Every run is bounded by ``max_iterations``: a regression fails, it never hangs.
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from context_mgmt.reset_limit import MAX_CONSECUTIVE_RESETS

FALLBACK = "automatic compact/clear is off"
RESET = ("context_reset", "", {"context_reset": True, "action": "clear"})


def _write_plan(spec: Path, *subtask_ids: str) -> None:
    plan = {
        "feature": "Small window",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "1",
                "name": "Implementation",
                "subtasks": [
                    {"id": sid, "description": f"Implement {sid}", "status": "pending"}
                    for sid in subtask_ids
                ],
            }
        ],
    }
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


def _current_subtask(spec: Path) -> str:
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    subtasks = plan["phases"][0]["subtasks"]
    return next(s["id"] for s in subtasks if s["status"] == "pending")


def _complete(spec: Path, subtask_id: str) -> None:
    path = spec / "implementation_plan.json"
    plan = json.loads(path.read_text(encoding="utf-8"))
    for subtask in plan["phases"][0]["subtasks"]:
        if subtask["id"] == subtask_id:
            subtask["status"] = "completed"
    path.write_text(json.dumps(plan), encoding="utf-8")


def _logged(spec: Path, needle: str) -> list[str]:
    logs = json.loads((spec / "task_logs.json").read_text(encoding="utf-8"))
    return [
        entry["content"]
        for phase in logs["phases"].values()
        for entry in phase.get("entries", [])
        if needle in entry["content"]
    ]


@pytest.fixture
def loop(monkeypatch, temp_git_repo):
    from agents import coder

    spec = temp_git_repo / ".workpilot" / "specs" / "001-small-window"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Small window\n", encoding="utf-8")

    class Client:
        model = "qwen2.5-coder:7b"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def provider_name(self):
            return "ollama"

    monkeypatch.setattr(coder, "create_agent_client", lambda *a, **kw: Client())
    monkeypatch.setattr(coder, "get_memory_context", AsyncMock(return_value=None))
    monkeypatch.setattr(coder, "load_subtask_context", lambda *a, **kw: {})
    monkeypatch.setattr(coder, "post_session_processing", AsyncMock(return_value=True))
    monkeypatch.setattr(coder, "AUTO_CONTINUE_DELAY_SECONDS", 0)
    monkeypatch.setattr(coder.asyncio, "sleep", AsyncMock())
    return coder, temp_git_repo, spec


@pytest.mark.asyncio
async def test_resets_stop_after_the_cap_and_the_subtask_completes(loop, monkeypatch):
    coder, project, spec = loop
    _write_plan(spec, "1.1")
    monitor_only: list[bool] = []

    async def session(*_args, context_managed=False, **kwargs):
        # The guard is still built after the fallback: the gauge keeps measuring.
        assert context_managed
        monitor_only.append(kwargs.get("context_monitor_only", False))
        if not monitor_only[-1]:
            return RESET
        _complete(spec, "1.1")
        return "complete", "done", {}

    monkeypatch.setattr(coder, "run_agent_session", session)
    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=10)

    assert monitor_only == [False] * MAX_CONSECUTIVE_RESETS + [True]
    assert len(_logged(spec, FALLBACK)) == 1


@pytest.mark.asyncio
async def test_a_session_that_ends_on_its_own_breaks_the_streak(loop, monkeypatch):
    coder, project, spec = loop
    _write_plan(spec, "1.1")
    below_cap = ["context_reset"] * (MAX_CONSECUTIVE_RESETS - 1)
    script = iter([*below_cap, "continue", *below_cap, "complete"])
    monitor_only: list[bool] = []

    async def session(*_args, **kwargs):
        monitor_only.append(kwargs.get("context_monitor_only", False))
        status = next(script)
        if status == "context_reset":
            return RESET
        if status == "complete":
            _complete(spec, "1.1")
        return status, "done", {}

    monkeypatch.setattr(coder, "run_agent_session", session)
    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=12)

    assert monitor_only == [False] * (2 * MAX_CONSECUTIVE_RESETS)
    assert not (spec / "task_logs.json").exists() or not _logged(spec, FALLBACK)


@pytest.mark.asyncio
async def test_the_next_subtask_is_managed_again(loop, monkeypatch):
    coder, project, spec = loop
    _write_plan(spec, "1.1", "1.2")
    sessions: list[tuple[str, bool]] = []

    async def session(*_args, **kwargs):
        subtask = _current_subtask(spec)
        sessions.append((subtask, kwargs.get("context_monitor_only", False)))
        if subtask == "1.1" and not sessions[-1][1]:
            return RESET
        _complete(spec, subtask)
        return "continue", "done", {}

    monkeypatch.setattr(coder, "run_agent_session", session)
    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=10)

    assert sessions == [
        *[("1.1", False)] * MAX_CONSECUTIVE_RESETS,
        ("1.1", True),
        ("1.2", False),
    ]


@pytest.mark.asyncio
async def test_the_followup_planner_stops_resetting_too(monkeypatch, temp_git_repo):
    from agents import planner

    spec = temp_git_repo / ".workpilot" / "specs" / "002-followup"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Follow-up\n", encoding="utf-8")
    (spec / "FOLLOWUP_REQUEST.md").write_text("Add an export.\n", encoding="utf-8")

    class Client:
        model = "qwen2.5-coder:7b"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

    monitor_only: list[bool] = []

    async def session(*_args, context_managed=False, **kwargs):
        assert context_managed
        monitor_only.append(kwargs.get("context_monitor_only", False))
        if not monitor_only[-1] and len(monitor_only) <= 10:
            return RESET
        _write_plan(spec, "2.1")
        return "complete", "planned", {}

    monkeypatch.setattr(planner, "_create_planning_client", lambda *a: Client())
    monkeypatch.setattr(planner, "run_agent_session", session)

    assert await planner.run_followup_planner(temp_git_repo, spec, "test-model")
    assert monitor_only == [False] * MAX_CONSECUTIVE_RESETS + [True]
    assert len(_logged(spec, FALLBACK)) == 1
