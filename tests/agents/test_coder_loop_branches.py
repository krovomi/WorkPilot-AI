"""The coder loop's checkpoints around each session.

Before a session: a pause from the app, a PAUSE file, a build already
complete, a subtask a dead process left half done, a subtask whose files do
not exist. After one: an agent that asks whether to block a manual check, a
hot swap. The client and the session are stand-ins (the model boundary, as in
``test_coder_error_branches.py``); the plan, the recovery records, the status
file and the events are real.

Every run is bounded by ``max_iterations``: a regression fails, it never hangs.
"""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from foundation.build_signals import BuildPaused
from foundation.pause_state import write_pause_state


def _write_plan(spec: Path, *subtasks: dict) -> None:
    plan = {
        "feature": "Loop branches",
        "workflow_type": "feature",
        "phases": [{"id": "1", "name": "Implementation", "subtasks": list(subtasks)}],
    }
    (spec / "implementation_plan.json").write_text(json.dumps(plan), encoding="utf-8")


def _subtask(sid: str, status: str = "pending", **extra) -> dict:
    return {"id": sid, "description": f"Implement {sid}", "status": status, **extra}


def _status_of(spec: Path, sid: str) -> str:
    plan = json.loads((spec / "implementation_plan.json").read_text(encoding="utf-8"))
    [subtask] = [s for s in plan["phases"][0]["subtasks"] if s["id"] == sid]
    return subtask["status"]


class _Client:
    model = "claude-test"

    def __init__(self) -> None:
        self.queries: list[str] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def provider_name(self) -> str:
        return "claude"

    async def query(self, prompt: str) -> None:
        self.queries.append(prompt)

    async def receive_response(self):
        class _Text:
            text = "Marked it blocked."

        class _Message:
            content = [_Text()]

        yield _Message()


@pytest.fixture
def loop(monkeypatch, temp_git_repo):
    from agents import coder

    spec = temp_git_repo / ".workpilot" / "specs" / "001-loop"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Loop branches\n", encoding="utf-8")
    client = _Client()
    monkeypatch.setattr(coder, "create_agent_client", lambda *a, **kw: client)
    monkeypatch.setattr(coder, "get_memory_context", AsyncMock(return_value=None))
    monkeypatch.setattr(coder, "load_subtask_context", lambda *a, **kw: {})
    monkeypatch.setattr(coder, "post_session_processing", AsyncMock(return_value=True))
    monkeypatch.setattr(coder, "AUTO_CONTINUE_DELAY_SECONDS", 0)
    sleeps: list[float] = []

    async def sleep(seconds, *_a, **_kw):
        sleeps.append(seconds)

    monkeypatch.setattr(coder.asyncio, "sleep", sleep)

    def sessions(*steps):
        script = iter(steps)
        prompts: list[str] = []

        async def session(_client, prompt, *_args, **_kwargs):
            prompts.append(prompt)
            step = next(script)
            if callable(step):
                return step()
            return step

        monkeypatch.setattr(coder, "run_agent_session", session)
        return prompts

    return coder, temp_git_repo, spec, sessions, client


def _complete(spec: Path, sid: str):
    def done():
        path = spec / "implementation_plan.json"
        plan = json.loads(path.read_text(encoding="utf-8"))
        for subtask in plan["phases"][0]["subtasks"]:
            if subtask["id"] == sid:
                subtask["status"] = "completed"
        path.write_text(json.dumps(plan), encoding="utf-8")
        return "complete", "done", {}

    return done


# -- before a session ----------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_pause_from_the_app_stops_the_build_where_it_is(loop, capsys):
    coder, project, spec, sessions, _ = loop
    _write_plan(spec, _subtask("1.1"))
    write_pause_state(
        spec, phase="coding", subtask_id="1.1", provider="claude", model="opus"
    )
    prompts = sessions()

    with pytest.raises(BuildPaused) as paused:
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert (paused.value.phase, paused.value.subtask_id) == ("coding", "1.1")
    assert prompts == []
    out = capsys.readouterr().out
    assert "TASK PAUSED" in out
    assert "Paused subtask: 1.1" in out
    assert "Provider: claude (opus)" in out


@pytest.mark.asyncio
async def test_a_pause_file_stops_the_build_with_its_message(loop, capsys):
    coder, project, spec, sessions, _ = loop
    _write_plan(spec, _subtask("1.1"))
    (spec / "PAUSE").write_text("checking the schema first\n", encoding="utf-8")
    sessions()

    with pytest.raises(BuildPaused) as paused:
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert paused.value.phase == "coding"
    out = capsys.readouterr().out
    assert "PAUSED BY HUMAN" in out
    assert "Message: checking the schema first" in out


@pytest.mark.asyncio
async def test_a_build_already_complete_says_so_and_runs_nothing(loop, capsys):
    coder, project, spec, sessions, _ = loop
    _write_plan(spec, _subtask("1.1", "completed"), _subtask("1.2", "completed"))
    prompts = sessions()

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert prompts == []
    events = [
        json.loads(line.split(":", 1)[1])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("__TASK_EVENT__:")
    ]
    assert {"type": "ALL_SUBTASKS_DONE", "totalCount": 2}.items() <= {
        **events[-1]
    }.items()


@pytest.mark.asyncio
async def test_a_subtask_a_dead_process_left_is_continued(loop, capsys):
    coder, project, spec, sessions, _ = loop
    _write_plan(spec, _subtask("1.1", "completed"), _subtask("1.2", "in_progress"))
    prompts = sessions(_complete(spec, "1.2"))

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert "Resuming interrupted subtask(s): 1.2" in capsys.readouterr().out
    assert len(prompts) == 1 and "1.2" in prompts[0]
    assert _status_of(spec, "1.2") == "completed"


@pytest.mark.asyncio
async def test_a_subtask_whose_files_do_not_exist_is_not_run_and_ends_stuck(
    loop, capsys
):
    coder, project, spec, sessions, _ = loop
    _write_plan(
        spec, _subtask("1.1", files_to_modify=["src/does_not_exist/handler.py"])
    )
    prompts = sessions()

    await coder.run_autonomous_agent(
        project, spec, "test-model", max_iterations=coder.MAX_SUBTASK_RETRIES + 2
    )

    # No session is spent on it: each iteration records a failed attempt.
    assert prompts == []
    out = capsys.readouterr().out
    assert "File validation failed: Planned files do not exist" in out
    assert (
        f"Subtask 1.1 marked as STUCK after {coder.MAX_SUBTASK_RETRIES} failed "
        "validation attempts"
    ) in out
    # Stuck is blocked: the build goes on to review, listing it for a person.
    assert _status_of(spec, "1.1") == "blocked"
    assert "STUCK SUBTASKS (need manual intervention)" in out


# -- after a session -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_an_agent_asking_whether_to_block_a_manual_check_is_answered(loop):
    coder, project, spec, sessions, client = loop
    _write_plan(spec, _subtask("1.1"))
    sessions(
        ("continue", "Should I mark this subtask as blocked?", {}),
        _complete(spec, "1.1"),
    )

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=4)

    [answer] = client.queries
    assert "mark the subtask completed" in answer
    assert "blocked_reason" in answer


@pytest.mark.asyncio
async def test_a_hot_swap_reruns_the_same_subtask(loop):
    coder, project, spec, sessions, _ = loop
    _write_plan(spec, _subtask("1.1"))
    prompts = sessions(("hot_swap", "", {}), _complete(spec, "1.1"))

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=4)

    assert len(prompts) == 2
    assert all("1.1" in p for p in prompts)
    assert _status_of(spec, "1.1") == "completed"


# -- the swarm ---------------------------------------------------------------------


def _swarm(monkeypatch, coder, spec, *built: str, complete: bool):
    calls: list[tuple] = []

    async def run_swarm_phase(project_dir, spec_dir, source_spec_dir):
        calls.append((project_dir, spec_dir, source_spec_dir))
        if len(calls) == 1:
            for sid in built:
                _complete(spec, sid)()
            return complete
        return False

    monkeypatch.setattr(coder, "run_swarm_phase", run_swarm_phase)
    return calls


@pytest.mark.asyncio
async def test_a_swarm_that_built_everything_ends_the_coding(loop, monkeypatch):
    coder, project, spec, sessions, _ = loop
    _write_plan(spec, _subtask("1.1"), _subtask("1.2"))
    calls = _swarm(monkeypatch, coder, spec, "1.1", "1.2", complete=True)
    prompts = sessions()

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert prompts == []
    assert calls == [(project, spec, None)]
    assert _status_of(spec, "1.2") == "completed"


@pytest.mark.asyncio
async def test_what_the_swarm_left_is_built_by_the_coder(loop, monkeypatch):
    coder, project, spec, sessions, _ = loop
    _write_plan(spec, _subtask("1.1"), _subtask("1.2"))
    _swarm(monkeypatch, coder, spec, "1.1", complete=False)
    prompts = sessions(_complete(spec, "1.2"))

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=3)

    assert len(prompts) == 1 and "1.2" in prompts[0]
    assert _status_of(spec, "1.2") == "completed"
