"""The follow-up planner: new work added to a finished spec.

``run_followup_planner`` runs planning sessions until one ends, then checks
the plan really gained pending subtasks. The planning client and the session
are stand-ins (the model boundary, as in ``test_context_reset_coder.py``);
the plan, the hot-swap marker, the rate-limit pause and the prompt-too-long
halt are the real files.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents import planner
from agents.hot_swap import write_hot_swap_marker
from ui import BuildState, StatusManager


def _write_plan(spec: Path, *statuses: str) -> None:
    plan = {
        "feature": "Follow-up",
        "workflow_type": "feature",
        "phases": [
            {
                "id": "1",
                "name": "Implementation",
                "subtasks": [
                    {"id": f"1.{i}", "description": f"do {i}", "status": status}
                    for i, status in enumerate(statuses, start=1)
                ],
            }
        ],
    }
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


class _Client:
    model = "claude-test"

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


@pytest.fixture
def followup(monkeypatch, temp_git_repo):
    spec = temp_git_repo / ".workpilot" / "specs" / "002-followup"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Follow-up\n", encoding="utf-8")
    (spec / "FOLLOWUP_REQUEST.md").write_text("Add a CSV export.\n", encoding="utf-8")
    clients: list[_Client] = []

    def create(*_args):
        clients.append(_Client())
        return clients[-1]

    monkeypatch.setattr(planner, "_create_planning_client", create)

    def sessions(*steps):
        script = iter(steps)
        prompts: list[str] = []

        async def session(_client, prompt, *_args, **_kwargs):
            prompts.append(prompt)
            step = next(script)
            return step() if callable(step) else step

        monkeypatch.setattr(planner, "run_agent_session", session)
        return prompts

    return temp_git_repo, spec, sessions, clients


def _state(project: Path) -> BuildState:
    status = StatusManager(project)
    return status.read().state


def _plans(spec: Path, *statuses: str):
    def write():
        _write_plan(spec, *statuses)
        return "complete", "planned", {}

    return write


@pytest.mark.asyncio
async def test_new_pending_subtasks_end_the_follow_up_planning(followup, capsys):
    project, spec, sessions, _ = followup
    prompts = sessions(_plans(spec, "completed", "pending", "pending"))

    assert await planner.run_followup_planner(project, spec, "test-model") is True
    assert len(prompts) == 1
    out = capsys.readouterr().out
    assert "FOLLOW-UP PLANNER SESSION" in out


@pytest.mark.asyncio
async def test_a_plan_without_new_work_pauses_the_build(followup, capsys):
    project, spec, sessions, _ = followup
    sessions(_plans(spec, "completed"))

    assert await planner.run_followup_planner(project, spec, "test-model") is False
    assert "No pending subtasks found after planning" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_no_plan_after_planning_is_an_error(followup, capsys):
    project, spec, sessions, _ = followup
    sessions(("complete", "done", {}))

    assert await planner.run_followup_planner(project, spec, "test-model") is False
    assert "implementation_plan.json not found after planning" in (
        capsys.readouterr().out
    )


@pytest.mark.asyncio
async def test_a_session_error_fails_the_follow_up(followup, capsys):
    project, spec, sessions, _ = followup
    sessions(("error", "", {"type": "other", "message": "boom"}))

    assert await planner.run_followup_planner(project, spec, "test-model") is False
    assert "Follow-up planning failed" in capsys.readouterr().out
    logs = json.loads((spec / "task_logs.json").read_text(encoding="utf-8"))
    assert logs["phases"]["planning"]["status"] == "failed"


@pytest.mark.asyncio
async def test_a_prompt_too_long_halts_with_its_marker(followup):
    project, spec, sessions, _ = followup
    prompts = sessions(
        ("error", "", {"type": "prompt_too_long", "message": "Prompt is too long"})
    )

    assert await planner.run_followup_planner(project, spec, "test-model") is False
    assert len(prompts) == 1
    assert (spec / "PROMPT_TOO_LONG_HALT").is_file()


@pytest.mark.asyncio
async def test_a_rate_limit_pauses_then_plans_again(followup, capsys):
    project, spec, sessions, clients = followup
    # The user already pressed Resume: the pause ends at its first check.
    (spec / "RESUME").write_text("", encoding="utf-8")
    prompts = sessions(
        (
            "error",
            "",
            {"type": "rate_limit", "message": "429 rate limit, try again in 5 minutes"},
        ),
        _plans(spec, "pending"),
    )

    assert await planner.run_followup_planner(project, spec, "test-model") is True
    # A new client for the retry: it runs under the metadata as it is now.
    assert len(prompts) == 2 and len(clients) == 2
    assert "Resumed early by user" in capsys.readouterr().out


@pytest.mark.asyncio
async def test_a_hot_swap_plans_again_under_the_new_model(followup):
    project, spec, sessions, clients = followup
    write_hot_swap_marker(spec, "planning", provider="claude", model="opus")
    prompts = sessions(("hot_swap", "", {}), _plans(spec, "pending"))

    assert await planner.run_followup_planner(project, spec, "test-model") is True
    assert len(prompts) == 2 and len(clients) == 2
    metadata = json.loads((spec / "task_metadata.json").read_text(encoding="utf-8"))
    assert "opus" in json.dumps(metadata)
    logs = (spec / "task_logs.json").read_text(encoding="utf-8")
    assert "opus" in logs


@pytest.mark.asyncio
async def test_a_crash_in_the_session_fails_the_follow_up(followup, capsys):
    project, spec, sessions, _ = followup

    def crash():
        raise RuntimeError("socket closed")

    sessions(crash)

    assert await planner.run_followup_planner(project, spec, "test-model") is False
    assert "Follow-up planning error: socket closed" in capsys.readouterr().out


# -- the planning client ------------------------------------------------------------


def _captured(monkeypatch) -> list[dict]:
    calls: list[dict] = []

    def create_agent_client(**kwargs):
        calls.append(kwargs)
        return _Client()

    monkeypatch.setattr(planner, "create_agent_client", create_agent_client)
    return calls


def test_the_planning_client_is_the_planner_with_its_phase_model(
    monkeypatch, tmp_path: Path
) -> None:
    calls = _captured(monkeypatch)

    planner._create_planning_client(tmp_path, tmp_path, "claude-sonnet-test")

    [call] = calls
    assert call["agent_type"] == "planner"
    assert call["model"] == "claude-sonnet-test"
    # No metadata: the provider is left to the client's own default.
    assert call["provider"] is None


def test_a_planning_provider_chosen_for_the_task_is_used(
    monkeypatch, tmp_path: Path
) -> None:
    (tmp_path / "task_metadata.json").write_text(
        json.dumps({"phaseProviders": {"planning": "openai"}}), encoding="utf-8"
    )
    calls = _captured(monkeypatch)

    planner._create_planning_client(tmp_path, tmp_path, "gpt-test")

    assert calls[0]["provider"] == "openai"


# -- opt-in wiring: the model router, the domain agents --------------------------------


def _trail(project: Path) -> str:
    from agents.agent_audit import _project_trail_dir

    folder = _project_trail_dir(project)
    return "\n".join(
        p.read_text(encoding="utf-8") for p in sorted(folder.rglob("*")) if p.is_file()
    )


@pytest.mark.asyncio
async def test_the_router_substitutes_a_default_model_and_says_so(
    followup, monkeypatch
):
    project, spec, sessions, _ = followup
    monkeypatch.setenv("WORKPILOT_MODEL_ROUTER_ENABLED", "1")
    sessions(_plans(spec, "pending"))

    assert await planner.run_followup_planner(project, spec, "test-model") is True
    assert "router-override-planner-002-followup" in _trail(project)


@pytest.mark.asyncio
async def test_the_router_only_suggests_when_the_user_picked_the_model(
    followup, monkeypatch
):
    project, spec, sessions, _ = followup
    monkeypatch.setenv("WORKPILOT_MODEL_ROUTER_ENABLED", "1")
    (spec / "task_metadata.json").write_text(
        json.dumps({"model": "test-model"}), encoding="utf-8"
    )
    (spec / "requirements.json").write_text(
        json.dumps({"domain": "ecommerce"}), encoding="utf-8"
    )
    sessions(_plans(spec, "pending"))

    assert await planner.run_followup_planner(project, spec, "test-model") is True
    trail = _trail(project)
    assert "router-suggest-planner-002-followup" in trail
    assert "router-override-planner" not in trail
    assert "domain addendum available for planner" in trail
