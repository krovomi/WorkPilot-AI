"""The coder's waits and its handling of the plan between planning and coding.

* a paused build (rate limit, expired sign-in) waits for the RESUME file the
  app writes, in the worktree's spec or the main project's;
* a plan the model got wrong is fixed, recovered from where it was written,
  or sent back to the planner with the validator's errors, until the cap;
* the requirement coverage of a valid plan is reported.

Everything runs on real files; the only stand-in is the planning client,
asked for nothing but its provider's name.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from agents import coder
from foundation.build_signals import BuildHalted
from ui import BuildState, StatusManager

PLAN = {
    "feature": "login",
    "workflow_type": "feature",
    "phases": [
        {
            "id": "p1",
            "name": "Backend",
            "subtasks": [
                {
                    "id": "1.1",
                    "description": "session API",
                    "status": "pending",
                    "requirements": ["FR-001"],
                }
            ],
        }
    ],
}


@pytest.fixture
def spec(tmp_path: Path) -> Path:
    spec_dir = tmp_path / "shop" / ".workpilot" / "specs" / "001-login"
    spec_dir.mkdir(parents=True)
    return spec_dir


def _project(spec: Path) -> Path:
    return spec.parents[2]


@pytest.fixture
def fast_checks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(coder, "RATE_LIMIT_CHECK_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(coder, "AUTH_RESUME_CHECK_INTERVAL_SECONDS", 0.01)


# -- the RESUME file -----------------------------------------------------------


def test_a_resume_file_in_the_worktree_clears_both_files(spec: Path) -> None:
    resume, pause = spec / coder.RESUME_FILE, spec / coder.RATE_LIMIT_PAUSE_FILE
    resume.write_text("", encoding="utf-8")
    pause.write_text("{}", encoding="utf-8")

    assert coder._check_and_clear_resume_file(resume, pause) is True
    assert not resume.exists() and not pause.exists()


def test_a_resume_file_in_the_main_project_counts_too(
    spec: Path, tmp_path: Path
) -> None:
    main_spec = tmp_path / "main" / "001-login"
    main_spec.mkdir(parents=True)
    fallback = main_spec / coder.RESUME_FILE
    fallback.write_text("", encoding="utf-8")
    pause = spec / coder.RATE_LIMIT_PAUSE_FILE
    pause.write_text("{}", encoding="utf-8")

    assert (
        coder._check_and_clear_resume_file(spec / coder.RESUME_FILE, pause, fallback)
        is True
    )
    assert not fallback.exists() and not pause.exists()


def test_without_a_resume_file_nothing_is_touched(spec: Path) -> None:
    pause = spec / coder.RATE_LIMIT_PAUSE_FILE
    pause.write_text("{}", encoding="utf-8")

    assert (
        coder._check_and_clear_resume_file(
            spec / coder.RESUME_FILE, pause, spec / "missing" / coder.RESUME_FILE
        )
        is False
    )
    assert pause.exists()


# -- waiting out a rate limit ----------------------------------------------------


def test_a_rate_limit_wait_ends_early_on_resume(spec: Path, fast_checks) -> None:
    (spec / coder.RATE_LIMIT_PAUSE_FILE).write_text("{}", encoding="utf-8")

    async def scenario() -> bool:
        waiting = asyncio.create_task(coder.wait_for_rate_limit_reset(spec, 30))
        await asyncio.sleep(0.05)
        (spec / coder.RESUME_FILE).write_text("", encoding="utf-8")
        return await asyncio.wait_for(waiting, timeout=5)

    assert asyncio.run(scenario()) is True
    assert not (spec / coder.RATE_LIMIT_PAUSE_FILE).exists()


def test_a_rate_limit_wait_runs_its_course_and_clears_the_pause(
    spec: Path, fast_checks
) -> None:
    (spec / coder.RATE_LIMIT_PAUSE_FILE).write_text("{}", encoding="utf-8")

    resumed = asyncio.run(coder.wait_for_rate_limit_reset(spec, 0.05, spec.parent))

    assert resumed is False
    assert not (spec / coder.RATE_LIMIT_PAUSE_FILE).exists()


# -- waiting for a new sign-in ---------------------------------------------------


def test_an_auth_wait_ends_on_resume(spec: Path, fast_checks) -> None:
    pause = spec / coder.AUTH_FAILURE_PAUSE_FILE
    pause.write_text("{}", encoding="utf-8")

    async def scenario() -> None:
        waiting = asyncio.create_task(coder.wait_for_auth_resume(spec))
        await asyncio.sleep(0.05)
        (spec / coder.RESUME_FILE).write_text("", encoding="utf-8")
        await asyncio.wait_for(waiting, timeout=5)

    asyncio.run(scenario())
    assert not pause.exists()
    assert not (spec / coder.RESUME_FILE).exists()


def test_an_auth_wait_ends_when_the_pause_is_removed(spec: Path, fast_checks) -> None:
    pause = spec / coder.AUTH_FAILURE_PAUSE_FILE
    pause.write_text("{}", encoding="utf-8")

    async def scenario() -> None:
        waiting = asyncio.create_task(coder.wait_for_auth_resume(spec, spec.parent))
        await asyncio.sleep(0.05)
        pause.unlink()
        await asyncio.wait_for(waiting, timeout=5)

    asyncio.run(scenario())


def test_an_auth_wait_gives_up_after_its_maximum(
    spec: Path, fast_checks, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.setattr(coder, "AUTH_RESUME_MAX_WAIT_SECONDS", 0.05)
    pause = spec / coder.AUTH_FAILURE_PAUSE_FILE
    pause.write_text("{}", encoding="utf-8")

    asyncio.run(coder.wait_for_auth_resume(spec))

    assert not pause.exists()
    assert "Authentication wait timeout reached" in capsys.readouterr().out


# -- a plan the model got wrong --------------------------------------------------


def _write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8")


def test_a_valid_plan_is_taken_as_it_is(spec: Path) -> None:
    _write(spec / "implementation_plan.json", json.dumps(PLAN))

    assert coder._validate_and_fix_implementation_plan(spec, _project(spec), None) == (
        True,
        [],
    )


def test_a_plan_in_a_code_fence_is_fixed_in_place(spec: Path) -> None:
    _write(spec / "implementation_plan.json", "```json\n" + json.dumps(PLAN) + "\n```")

    ok, errors = coder._validate_and_fix_implementation_plan(spec, _project(spec), None)

    assert (ok, errors) == (True, [])
    assert (
        json.loads((spec / "implementation_plan.json").read_text("utf-8"))["phases"][0][
            "subtasks"
        ][0]["id"]
        == "1.1"
    )


def test_a_plan_written_at_the_worktree_root_is_recovered(
    spec: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(_project(spec) / "implementation_plan.json", json.dumps(PLAN))

    class _Log:
        lines: list[str] = []

        def log_info(self, line: str) -> None:
            self.lines.append(line)

    log = _Log()
    ok, errors = coder._validate_and_fix_implementation_plan(spec, _project(spec), log)

    assert (ok, errors) == (True, [])
    assert (spec / "implementation_plan.json").is_file()
    out = capsys.readouterr().out
    assert "Recovered the implementation plan from" in out
    assert "(1 subtask(s))" in out
    assert log.lines and log.lines[0].startswith("Recovered the implementation plan")


def test_a_plan_only_in_the_model_answer_is_recovered(spec: Path) -> None:
    answer = "Here is the plan:\n```json\n" + json.dumps(PLAN) + "\n```"

    ok, _ = coder._validate_and_fix_implementation_plan(
        spec, _project(spec), None, response_text=answer
    )

    assert ok
    assert json.loads((spec / "implementation_plan.json").read_text("utf-8"))[
        "feature"
    ] == ("login")


def test_no_plan_anywhere_returns_the_validator_errors(spec: Path) -> None:
    _write(spec / "implementation_plan.json", '{"feature": "login"}')

    ok, errors = coder._validate_and_fix_implementation_plan(
        spec, _project(spec), None, response_text="I could not finish."
    )

    assert not ok
    assert errors


def test_a_recovery_that_breaks_never_fails_the_build(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import spec.plan_recovery as plan_recovery

    def broken(*_args, **_kwargs):
        raise OSError("disk gone")

    monkeypatch.setattr(plan_recovery, "recover_plan", broken)

    assert coder._recover_implementation_plan(spec, _project(spec), None, "x") is False


# -- sending the plan back, until the cap ------------------------------------------


class _Planner:
    def __init__(self, provider: str | None) -> None:
        self._provider = provider

    def provider_name(self) -> str:
        if self._provider is None:
            raise RuntimeError("no provider on this client")
        return self._provider


def test_an_invalid_plan_is_sent_back_then_halts_at_the_cap(
    spec: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    project = _project(spec)
    _write(project / "implementation_plan.json", "{")
    status = StatusManager(project)
    errors = ["phases is required", "feature is required"]

    for attempt in range(1, coder.MAX_PLANNING_VALIDATION_RETRIES):
        told = coder._on_invalid_plan(
            spec,
            project,
            client=_Planner("ollama"),
            errors=errors,
            task_logger=None,
            status_manager=status,
        )
        assert told.startswith("## IMPLEMENTATION PLAN VALIDATION ERRORS")
        assert "- phases is required\n- feature is required" in told
        assert coder._read_planning_failures(spec) == attempt

    out = capsys.readouterr().out
    assert "retrying planner The local model produced an invalid plan" in out
    # The truncated "{" the model left at the worktree root is cleaned up.
    assert "Removed a stray/invalid implementation_plan.json" in out
    assert not (project / "implementation_plan.json").exists()

    with pytest.raises(BuildHalted) as halted:
        coder._on_invalid_plan(
            spec,
            project,
            client=_Planner(None),
            errors=errors,
            task_logger=None,
            status_manager=status,
        )

    assert "did not produce a valid implementation_plan.json" in str(halted.value)
    # A deliberate re-run starts with a fresh count.
    assert coder._read_planning_failures(spec) == 0
    status.flush()
    assert status.read().state is BuildState.ERROR
    out = capsys.readouterr().out
    assert "__TASK_EVENT__" in out and "PLANNING_FAILED" in out
    assert "- phases is required" in out


def test_the_cap_halt_ends_the_planning_phase_in_the_task_log(spec: Path) -> None:
    from task_logger import get_task_logger

    project = _project(spec)
    _write(spec / coder._PLANNING_FAILURES_MARKER, "2")
    _write(project / "implementation_plan.json", "[]")
    log = get_task_logger(spec)

    with pytest.raises(BuildHalted):
        coder._on_invalid_plan(
            spec,
            project,
            client=_Planner("claude"),
            errors=[],
            task_logger=log,
            status_manager=StatusManager(project),
        )

    logs = json.loads((spec / "task_logs.json").read_text(encoding="utf-8"))
    assert logs["phases"]["planning"]["status"] == "failed"


# -- requirement coverage ------------------------------------------------------------


def test_the_requirement_coverage_of_the_plan_is_reported(
    spec: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(
        spec / "spec.md",
        "# Login\n\n- FR-001: sign in\n- FR-002: sign out\n\n"
        "[NEEDS CLARIFICATION: which identity provider?]\n",
    )
    plan = json.loads(json.dumps(PLAN))
    plan["phases"][0]["subtasks"][0]["requirements"] = ["FR-001", "FR-009"]
    _write(spec / "implementation_plan.json", json.dumps(plan))

    coder._report_traceability(spec)

    out = capsys.readouterr().out
    assert "1 open question(s) left in spec.md" in out
    assert "Requirement coverage:" in out
    assert "No subtask claims: FR-002" in out
    assert "Subtask(s) 1.1 reference FR-009, which spec.md does not declare" in out
    assert (spec / "traceability.json").is_file()


def test_a_spec_without_requirements_reports_nothing(
    spec: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    _write(spec / "spec.md", "# Login\n\nJust make it work.\n")

    coder._report_traceability(spec)

    assert "Requirement coverage" not in capsys.readouterr().out


def test_a_traceability_record_that_breaks_never_fails_the_build(
    spec: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import foundation.traceability as traceability

    def broken(_spec_dir: Path) -> dict:
        raise OSError("disk gone")

    monkeypatch.setattr(traceability, "write_record", broken)

    coder._report_traceability(spec)


# -- the workflow window between planning and coding ---------------------------------


def test_no_workflow_profile_runs_no_phase(spec: Path) -> None:
    asyncio.run(
        coder._run_post_planning_phases(
            None,
            project_dir=_project(spec),
            spec_dir=spec,
            model="m",
            workflow_repo_root=_project(spec),
            jev_run=None,
            verbose=False,
        )
    )


def test_a_profile_the_engine_cannot_read_never_blocks_the_build(spec: Path) -> None:
    asyncio.run(
        coder._run_post_planning_phases(
            object(),
            project_dir=_project(spec),
            spec_dir=spec,
            model="m",
            workflow_repo_root=_project(spec),
            jev_run=None,
            verbose=False,
        )
    )
