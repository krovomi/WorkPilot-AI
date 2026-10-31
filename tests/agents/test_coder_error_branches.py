"""What the coder loop does with each kind of session error.

A halt ends the loop and the build raises ``BuildHalted`` with the error, so the
phase is reported failed rather than advanced.

These pin the behaviour of the error branch of ``run_autonomous_agent`` before
it is split into functions (audit of 17 October, lot M10): which errors are
retried and with which delay, which ones pause the build for the user, which
ones halt it, and what the next session is told.

Every run is bounded by ``max_iterations``: a regression fails, it never hangs.
"""

import json
from datetime import datetime
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from foundation.build_signals import BuildHalted
from foundation.phase_event import ExecutionPhase
from services.recovery import RecoveryManager


def _write_plan(spec: Path, *subtask_ids: str) -> None:
    plan = {
        "feature": "Error branches",
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


def _complete(spec: Path, subtask_id: str) -> None:
    path = spec / "implementation_plan.json"
    plan = json.loads(path.read_text(encoding="utf-8"))
    for subtask in plan["phases"][0]["subtasks"]:
        if subtask["id"] == subtask_id:
            subtask["status"] = "completed"
    path.write_text(json.dumps(plan), encoding="utf-8")


class Recorder:
    """The sessions run, the sleeps taken and the phases emitted."""

    def __init__(self, spec: Path, script: list):
        self.spec = spec
        self.script = iter(script)
        self.prompts: list[str] = []
        self.sleeps: list[float] = []
        self.phases: list[ExecutionPhase] = []

    async def session(self, _client, prompt, *_args, **_kwargs):
        self.prompts.append(prompt)
        step = next(self.script)
        if step == "complete":
            _complete(self.spec, "1.1")
            return "complete", "done", {}
        if step == "continue":
            return "continue", "working", {}
        if step == "plan":
            _write_plan(self.spec, "1.1")
            return "continue", "plan written", {}
        return "error", "", step

    async def sleep(self, seconds, *_args, **_kwargs):
        self.sleeps.append(seconds)


@pytest.fixture
def loop(monkeypatch, temp_git_repo):
    from agents import coder

    spec = temp_git_repo / ".workpilot" / "specs" / "001-error-branches"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Error branches\n", encoding="utf-8")
    _write_plan(spec, "1.1")

    class Client:
        model = "claude-test"

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return False

        def provider_name(self):
            return "claude"

    monkeypatch.setattr(coder, "create_agent_client", lambda *a, **kw: Client())
    monkeypatch.setattr(coder, "get_memory_context", AsyncMock(return_value=None))
    monkeypatch.setattr(coder, "load_subtask_context", lambda *a, **kw: {})
    monkeypatch.setattr(coder, "post_session_processing", AsyncMock(return_value=True))
    monkeypatch.setattr(coder, "AUTO_CONTINUE_DELAY_SECONDS", 0)

    def run(script: list, max_iterations: int = 12) -> Recorder:
        recorder = Recorder(spec, script)
        monkeypatch.setattr(coder, "run_agent_session", recorder.session)
        monkeypatch.setattr(coder.asyncio, "sleep", recorder.sleep)
        monkeypatch.setattr(
            coder,
            "emit_phase",
            lambda phase, *_a, **_kw: recorder.phases.append(phase),
        )
        return recorder

    return coder, temp_git_repo, spec, run


def _retry_sleeps(recorder: Recorder) -> list[float]:
    # The loop also waits 1 s between sessions; the retry delays are the rest.
    return [s for s in recorder.sleeps if s not in (0, 1)]


CONCURRENCY = {"type": "tool_concurrency", "message": "400 tool concurrency"}


@pytest.mark.asyncio
async def test_concurrency_errors_back_off_and_tell_the_next_session(loop):
    coder, project, spec, run = loop
    recorder = run([CONCURRENCY, CONCURRENCY, "complete"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert _retry_sleeps(recorder) == [2, 4]
    assert "TOOL CONCURRENCY ERROR" not in recorder.prompts[0]
    assert "retry 1/5" in recorder.prompts[1]
    assert "retry 2/5" in recorder.prompts[2]


@pytest.mark.asyncio
async def test_a_good_session_resets_the_backoff(loop):
    coder, project, spec, run = loop
    recorder = run([CONCURRENCY, "continue", CONCURRENCY, "complete"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=8)

    assert _retry_sleeps(recorder) == [2, 2]
    assert "TOOL CONCURRENCY ERROR" not in recorder.prompts[2]
    assert "retry 1/5" in recorder.prompts[3]


@pytest.mark.asyncio
async def test_too_many_concurrency_errors_mark_the_subtask_stuck(loop):
    coder, project, spec, run = loop
    recorder = run([CONCURRENCY] * 6 + ["complete"])

    with pytest.raises(BuildHalted):
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=12)

    assert len(recorder.prompts) == 6
    assert _retry_sleeps(recorder) == [2, 4, 8, 16, 32]
    stuck = RecoveryManager(spec, project).get_stuck_subtasks()
    assert [entry["subtask_id"] for entry in stuck] == ["1.1"]


@pytest.mark.asyncio
async def test_an_unavailable_model_halts_after_one_session(loop):
    coder, project, spec, run = loop
    recorder = run([{"type": "model_unavailable", "message": "no such model"}])

    with pytest.raises(BuildHalted):
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 1
    assert recorder.phases.count(ExecutionPhase.FAILED) == 2


@pytest.mark.asyncio
async def test_a_prompt_too_long_halts_without_a_fresh_thread(loop, monkeypatch):
    coder, project, spec, run = loop
    import context_mgmt.recovery as recovery
    import services.rate_limit_shield as shield

    monkeypatch.setattr(
        recovery, "recover_from_prompt_too_long", lambda *a, **kw: False
    )
    handled: list[str] = []
    monkeypatch.setattr(
        shield, "handle_prompt_too_long", lambda exc, *_a: handled.append(str(exc))
    )
    recorder = run([{"type": "prompt_too_long", "message": "prompt is too long"}])

    with pytest.raises(BuildHalted):
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 1
    assert handled == ["prompt is too long"]


@pytest.mark.asyncio
async def test_a_prompt_too_long_retries_on_a_fresh_thread(loop, monkeypatch):
    coder, project, spec, run = loop
    import context_mgmt.recovery as recovery

    monkeypatch.setattr(recovery, "recover_from_prompt_too_long", lambda *a, **kw: True)
    recorder = run([{"type": "prompt_too_long", "message": "too long"}, "complete"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 2


@pytest.mark.asyncio
async def test_a_rate_limit_pauses_until_its_reset(loop, monkeypatch):
    coder, project, spec, run = loop
    reset = int(datetime.now().timestamp()) + 600
    monkeypatch.setattr(coder, "parse_rate_limit_reset_time", lambda _info: reset)
    waited: list[float] = []

    async def wait(_spec, seconds, _source):
        waited.append(seconds)
        return False

    monkeypatch.setattr(coder, "wait_for_rate_limit_reset", wait)
    fake_key = "sk-test-" + "0" * 24
    recorder = run(
        [{"type": "rate_limit", "message": f"limit {fake_key} reached"}, "complete"]
    )

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 2
    assert len(waited) == 1 and 0 < waited[0] <= 600
    assert ExecutionPhase.RATE_LIMIT_PAUSED in recorder.phases
    pause = json.loads((spec / coder.RATE_LIMIT_PAUSE_FILE).read_text(encoding="utf-8"))
    assert pause["reset_timestamp"] == reset
    assert fake_key not in pause["error"]


@pytest.mark.asyncio
async def test_a_rate_limit_already_reset_retries_at_once(loop, monkeypatch):
    coder, project, spec, run = loop
    past = int(datetime.now().timestamp()) - 10
    monkeypatch.setattr(coder, "parse_rate_limit_reset_time", lambda _info: past)
    recorder = run([{"type": "rate_limit", "message": "limit"}, "complete"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 2
    assert 2 in recorder.sleeps
    assert not (spec / coder.RATE_LIMIT_PAUSE_FILE).exists()


@pytest.mark.asyncio
async def test_a_rate_limit_past_the_maximum_wait_halts(loop, monkeypatch):
    coder, project, spec, run = loop
    far = int(datetime.now().timestamp()) + coder.MAX_RATE_LIMIT_WAIT_SECONDS + 3600
    monkeypatch.setattr(coder, "parse_rate_limit_reset_time", lambda _info: far)
    recorder = run([{"type": "rate_limit", "message": "limit"}, "complete"])

    with pytest.raises(BuildHalted):
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 1
    assert not (spec / coder.RATE_LIMIT_PAUSE_FILE).exists()


@pytest.mark.asyncio
async def test_a_rate_limit_without_a_reset_time_retries(loop, monkeypatch):
    coder, project, spec, run = loop
    monkeypatch.setattr(coder, "parse_rate_limit_reset_time", lambda _info: None)
    recorder = run([{"type": "rate_limit", "message": "limit"}, "complete"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 2


@pytest.mark.asyncio
async def test_an_authentication_failure_pauses_for_the_user(loop, monkeypatch):
    coder, project, spec, run = loop
    resumed: list[Path] = []

    async def wait(spec_dir, _source):
        resumed.append(spec_dir)

    monkeypatch.setattr(coder, "wait_for_auth_resume", wait)
    recorder = run([{"type": "authentication", "message": "401"}, "complete"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert resumed == [spec]
    assert len(recorder.prompts) == 2
    assert ExecutionPhase.AUTH_FAILURE_PAUSED in recorder.phases
    pause = json.loads(
        (spec / coder.AUTH_FAILURE_PAUSE_FILE).read_text(encoding="utf-8")
    )
    assert pause["requires_action"] == "re-authenticate"


@pytest.mark.asyncio
async def test_the_same_error_three_times_halts_the_build(loop):
    coder, project, spec, run = loop
    same = {"type": "other", "message": "session limit · resets 3:20pm"}
    recorder = run([same, same, same, "complete"])

    with pytest.raises(BuildHalted) as halted:
        await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 3
    assert "3" in str(halted.value)


@pytest.mark.asyncio
async def test_different_errors_keep_retrying(loop):
    coder, project, spec, run = loop
    recorder = run(
        [
            {"type": "other", "message": "first"},
            {"type": "other", "message": "second"},
            {"type": "other", "message": "first"},
            "complete",
        ]
    )

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=8)

    assert len(recorder.prompts) == 4


@pytest.mark.asyncio
async def test_a_complete_session_announces_all_subtasks_done(loop, monkeypatch):
    coder, project, spec, run = loop
    events: list[str] = []

    class Emitter:
        def emit(self, name, _payload):
            events.append(name)

    monkeypatch.setattr(
        coder.TaskEventEmitter, "from_spec_dir", classmethod(lambda cls, _s: Emitter())
    )
    recorder = run(["complete", "continue"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert len(recorder.prompts) == 1
    assert "ALL_SUBTASKS_DONE" in events


@pytest.mark.asyncio
async def test_a_concurrency_error_while_planning_plans_again(loop):
    coder, project, spec, run = loop
    (spec / "implementation_plan.json").unlink()
    recorder = run([CONCURRENCY, "plan", "complete"])

    await coder.run_autonomous_agent(project, spec, "test-model", max_iterations=6)

    assert "TOOL CONCURRENCY ERROR" not in recorder.prompts[0]
    assert "retry 1/5" in recorder.prompts[1]
    assert "TOOL CONCURRENCY ERROR" not in recorder.prompts[2]
