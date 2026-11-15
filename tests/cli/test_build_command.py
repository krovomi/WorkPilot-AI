"""`handle_build_command`: which steps a build takes, and how it ends.

The phases themselves (planner, coder, QA, the workflow engine) have their own
tests; here they are replaced by recorders so each test can assert what the
orchestrator decided: whether it started, which workspace it used, which
verdict reached the card, and how each kind of stop is reported.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import core.agent
import pytest
import qa
from cli import build_commands as bc
from core.task_event import TASK_EVENT_PREFIX
from core.workspace import WorkspaceMode
from foundation.build_signals import BuildHalted, BuildPaused, BuildSplit
from review import ReviewState
from ui import BuildState


def _events(out: str) -> list[dict]:
    return [
        json.loads(line[len(TASK_EVENT_PREFIX) :])
        for line in out.splitlines()
        if line.startswith(TASK_EVENT_PREFIX)
    ]


def _plan(spec_dir: Path, *, done: bool, qa_status: str | None = None) -> None:
    plan = {
        "phases": [
            {
                "id": "p1",
                "subtasks": [
                    {"id": "s1", "status": "completed"},
                    {"id": "s2", "status": "completed" if done else "pending"},
                ],
            }
        ]
    }
    if qa_status:
        plan["qa_signoff"] = {"status": qa_status}
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )
    # The plan is part of what was approved.
    ReviewState().approve(spec_dir, approved_by="leub")


class _Worktree:
    base_branch = "develop"

    def __init__(self, log):
        self.log = log

    def settle_branch(self, name):
        self.log.append(("settle", name))

    def get_changed_files(self, name):
        return [("M", "src/app.py")]

    def remove_worktree(self, name, delete_branch=False):
        self.log.append(("remove", name, delete_branch))
        if self.log and self.log[0] == "remove-fails":
            raise OSError("busy")


@pytest.fixture
def build(tmp_path, monkeypatch):
    """A build whose every collaborator records what it was asked to do."""
    project = tmp_path / "project"
    spec = project / ".workpilot" / "specs" / "001-feature"
    spec.mkdir(parents=True)
    (spec / "spec.md").write_text("# Feature\n", encoding="utf-8")
    ReviewState().approve(spec, approved_by="leub")

    log: list = []
    knobs = SimpleNamespace(
        env_ok=True,
        existing=None,
        split=False,
        continue_existing=True,
        mode=WorkspaceMode.DIRECT,
        localized_spec=None,
        profile=None,
        agent_raises=None,
        qa_should_run=False,
        qa_result=True,
        repair=None,
        log=log,
        project=project,
        spec=spec,
        observe=None,
        agent=None,
        interrupt=None,
    )

    def validate_environment(spec_dir, problems=None):
        if not knobs.env_ok:
            problems.append("Claude n'est pas connecté")
        return knobs.env_ok

    monkeypatch.setattr("cli.utils.validate_environment", validate_environment)
    monkeypatch.setattr("cli.utils.print_banner", lambda: None)
    monkeypatch.setattr(bc, "get_existing_build_worktree", lambda p, n: knobs.existing)
    monkeypatch.setattr(bc, "split_before_build", lambda s, e: knobs.split)

    def check_existing(project_dir, name):
        log.append(("check-existing", name))
        return knobs.continue_existing

    monkeypatch.setattr(bc, "check_existing_build", check_existing)

    def choose(project_dir, name, **kwargs):
        log.append(("choose", kwargs))
        return knobs.mode

    monkeypatch.setattr(bc, "choose_workspace", choose)
    worktree = _Worktree(log)
    knobs.worktree = worktree

    def setup(project_dir, name, mode, **kwargs):
        log.append(("setup", kwargs["base_branch"], kwargs["use_local_branch"]))
        return project / "wt", worktree, knobs.localized_spec

    monkeypatch.setattr(bc, "setup_workspace", setup)
    monkeypatch.setattr(
        bc,
        "finalize_workspace",
        lambda p, n, wm, auto_continue: (
            log.append(("finalize", auto_continue)) or "merge"
        ),
    )
    monkeypatch.setattr(
        bc,
        "handle_workspace_choice",
        lambda choice, p, n, wm: log.append(("choice", choice)),
    )
    monkeypatch.setattr(bc, "start_digest_heartbeat", lambda s, p: None)
    monkeypatch.setattr(bc, "print_paused_banner", lambda *a, **k: None)

    class Status:
        def __init__(self, project_dir):
            pass

        def update(self, state):
            log.append(("status", state))

    monkeypatch.setattr(bc, "StatusManager", Status)
    monkeypatch.setattr(bc, "_resolve_workflow_profile", lambda *a, **k: knobs.profile)
    for quiet in (
        "_run_docs_preflight",
        "_run_attachments_preflight",
        "_run_dotnet_preflight",
        "_check_review_load",
        "_report_hard_gates",
        "_write_requirement_links",
        "_record_build_in_brain",
        "_sync_spec_back",
    ):
        monkeypatch.setattr(bc, quiet, lambda *a, **k: None)
    monkeypatch.setattr(bc, "_run_deterministic_gates", lambda *a, **k: None)
    monkeypatch.setattr(bc, "_run_workflow_phases", lambda *a, **k: None)
    monkeypatch.setattr(bc, "_tests_went_green", lambda spec_dir: None)

    def observe(spec_dir, **kwargs):
        knobs.observe = kwargs

    monkeypatch.setattr(bc, "_run_observe_phase", observe)

    def interrupt(**kwargs):
        knobs.interrupt = kwargs

    monkeypatch.setattr(bc, "_handle_build_interrupt", interrupt)

    async def agent(**kwargs):
        knobs.agent = kwargs
        if knobs.agent_raises is not None:
            raise knobs.agent_raises

    monkeypatch.setattr(core.agent, "run_autonomous_agent", agent)
    monkeypatch.setattr(
        core.agent,
        "sync_spec_to_source",
        lambda s, src: log.append(("sync", s.name)) or True,
    )
    monkeypatch.setattr(qa, "should_run_qa", lambda spec_dir: knobs.qa_should_run)

    async def qa_loop(**kwargs):
        log.append(("qa", kwargs["project_dir"]))
        if isinstance(knobs.qa_result, BaseException):
            raise knobs.qa_result
        return knobs.qa_result

    monkeypatch.setattr(qa, "run_qa_validation_loop", qa_loop)
    monkeypatch.setattr("integrations.jev.adapters.capture_base", lambda run, ref: None)

    def repair(working_dir, base):
        log.append(("repair", base))
        if isinstance(knobs.repair, BaseException):
            raise knobs.repair
        return knobs.repair or {}

    monkeypatch.setattr("core.encoding_repair.repair_worktree_changed_files", repair)

    def run(**overrides):
        args = {
            "project_dir": project,
            "spec_dir": spec,
            "model": "claude-sonnet-x",
            "max_iterations": None,
            "verbose": False,
            "force_isolated": False,
            "force_direct": False,
            "auto_continue": True,
            "skip_qa": True,
            "force_bypass_approval": False,
        }
        args.update(overrides)
        bc.handle_build_command(**args)

    knobs.run = run
    return knobs


def test_a_build_that_cannot_start_says_why_and_exits(build, capsys):
    build.env_ok = False

    with pytest.raises(SystemExit) as exit_info:
        build.run()

    assert exit_info.value.code == 1
    [event] = _events(capsys.readouterr().out)
    assert event["type"] == "PLANNING_FAILED"
    assert "Claude n'est pas connecté" in event["error"]
    assert build.agent is None


def test_an_unapproved_spec_is_blocked(build, capsys):
    (build.spec / "review_state.json").unlink()

    with pytest.raises(SystemExit) as exit_info:
        build.run()

    assert exit_info.value.code == 1
    out = capsys.readouterr().out
    assert "BUILD BLOCKED - REVIEW REQUIRED" in out
    assert "modified since approval" not in out
    assert build.agent is None


def test_a_spec_edited_after_approval_must_be_approved_again(build, capsys):
    (build.spec / "spec.md").write_text("# Feature, rewritten\n", encoding="utf-8")

    with pytest.raises(SystemExit):
        build.run()

    assert "The spec has been modified since approval." in capsys.readouterr().out


def test_force_bypasses_the_approval_with_a_warning(build, capsys):
    (build.spec / "review_state.json").unlink()

    build.run(force_bypass_approval=True, max_iterations=3)

    out = capsys.readouterr().out
    assert "Bypassing approval check with --force" in out
    assert "Max iterations: 3" in out
    assert build.agent["max_iterations"] == 3


def test_a_plan_split_into_several_cards_builds_nothing(build):
    build.split = True

    build.run()

    assert build.agent is None
    assert not [entry for entry in build.log if entry[0] == "choose"]


def test_an_existing_build_is_resumed_without_asking_in_auto_mode(build, capsys):
    build.existing = build.project / "wt"
    build.split = True  # never consulted once a build exists

    build.run(auto_continue=True)

    assert "Auto-continue: Resuming existing build..." in capsys.readouterr().out
    assert ("check-existing", "001-feature") not in build.log
    assert build.agent is not None


def test_an_existing_build_asks_the_user_in_interactive_mode(build):
    build.existing = build.project / "wt"

    build.run(auto_continue=False)

    assert ("check-existing", "001-feature") in build.log
    assert build.agent is not None


def test_a_direct_build_runs_the_coder_in_the_project(build, capsys):
    build.run()

    assert build.agent["project_dir"] == build.project
    assert build.agent["spec_dir"] == build.spec
    assert build.agent["source_spec_dir"] is None
    assert "Model: claude-sonnet-x" in capsys.readouterr().out
    assert not [entry for entry in build.log if entry[0] in {"finalize", "repair"}]


def test_phase_models_are_listed_when_they_differ(build, monkeypatch, capsys):
    models = {"planning": "claude-opus-1", "coding": "claude-sonnet-2", "qa": "haiku"}
    monkeypatch.setattr(
        "phase_config.get_phase_model", lambda spec, phase, default: models[phase]
    )

    build.run()

    assert "Models: Planning=opus, Coding=sonnet, QA=haiku" in capsys.readouterr().out


def test_an_isolated_build_works_in_the_worktree_and_finalizes_it(build, capsys):
    build.mode = WorkspaceMode.ISOLATED
    localized = build.project / "wt" / ".workpilot" / "specs" / "001-feature"
    localized.mkdir(parents=True)
    build.localized_spec = localized
    (build.spec / "task_metadata.json").write_text(
        json.dumps({"baseBranch": "release/2", "useLocalBranch": True}),
        encoding="utf-8",
    )
    build.repair = {"repaired": ["Strings.resx"], "unrepaired": {"Other.resx": 2}}

    build.run(auto_continue=False)

    assert ("setup", "release/2", True) in build.log
    assert build.agent["project_dir"] == build.project / "wt"
    assert build.agent["spec_dir"] == localized
    assert build.agent["source_spec_dir"] == build.spec
    assert ("repair", "release/2") in build.log
    assert ("settle", "001-feature") in build.log
    assert ("finalize", False) in build.log
    assert ("choice", "merge") in build.log
    assert build.observe["changed_files"] == ["src/app.py"]
    out = capsys.readouterr().out
    assert "restored accented characters in 1 file(s): Strings.resx" in out
    assert "remain in 1 file(s) — manual review: Other.resx" in out


def test_a_failing_encoding_repair_does_not_stop_the_build(build):
    build.mode = WorkspaceMode.ISOLATED
    build.repair = RuntimeError("git is gone")

    build.run()

    assert ("finalize", True) in build.log


def test_a_workflow_that_writes_no_code_skips_the_coder(build, capsys):
    build.profile = SimpleNamespace(
        workflow="investigation",
        effort="high",
        declared=("research", "report"),
        will_run=lambda phase: True,
    )

    build.run()

    assert build.agent is None
    out = capsys.readouterr().out
    assert "Workflow 'investigation' writes no code" in out
    assert [e["type"] for e in _events(out)] == ["QA_PASSED"]


def test_qa_that_approves_says_so_and_syncs_the_plan(build, capsys):
    build.qa_should_run = True

    build.run(skip_qa=False)

    out = capsys.readouterr().out
    assert "QA VALIDATION PASSED" in out
    assert ("sync", "001-feature") in build.log
    assert build.observe["qa_approved"] is True
    assert build.observe["ran_qa"] is True


def test_qa_that_does_not_approve_points_to_its_report(build, capsys):
    build.qa_should_run = True
    build.qa_result = False

    build.run(skip_qa=False)

    out = capsys.readouterr().out
    assert "QA VALIDATION INCOMPLETE" in out
    assert "--spec 001-feature --qa" in out
    assert build.observe["qa_approved"] is False


def test_qa_interrupted_by_the_user_is_not_an_approval(build, capsys):
    build.qa_should_run = True
    build.qa_result = KeyboardInterrupt()

    build.run(skip_qa=False)

    assert "QA validation paused." in capsys.readouterr().out
    assert build.observe["qa_approved"] is False
    assert ("finalize", True) not in build.log  # direct mode: nothing to finalize


def test_an_effort_level_that_buys_no_qa_skips_it(build, capsys):
    build.qa_should_run = True
    build.profile = SimpleNamespace(
        workflow="feature-build",
        effort="low",
        declared=("planning", "coding", "qa"),
        will_run=lambda phase: phase != "qa",
    )

    build.run(skip_qa=False)

    out = capsys.readouterr().out
    assert (
        "QA skipped — workflow 'feature-build' does not run it at effort 'low'" in out
    )
    assert not [entry for entry in build.log if entry[0] == "qa"]
    assert build.observe["ran_qa"] is False


def test_a_finished_build_already_approved_by_qa_moves_to_review(build, capsys):
    _plan(build.spec, done=True, qa_status="approved")

    build.run(skip_qa=True)

    assert [e["type"] for e in _events(capsys.readouterr().out)] == ["QA_PASSED"]


def test_a_finished_build_whose_goal_is_unmet_does_not_pass(build, monkeypatch, capsys):
    _plan(build.spec, done=True, qa_status="approved")
    monkeypatch.setattr(bc, "_goal_allows_done", lambda *a: False)

    build.run(skip_qa=True)

    assert [e["type"] for e in _events(capsys.readouterr().out)] == [
        "QA_MAX_ITERATIONS"
    ]
    assert build.observe["qa_approved"] is False


def test_a_workflow_without_qa_ends_a_finished_build_in_review(build, capsys):
    _plan(build.spec, done=True)
    build.profile = SimpleNamespace(
        workflow="docs",
        effort="high",
        declared=("planning", "coding"),
        will_run=lambda phase: True,
    )

    build.run(skip_qa=True)

    assert [e["type"] for e in _events(capsys.readouterr().out)] == ["QA_PASSED"]


def test_an_unfinished_build_emits_no_verdict(build, capsys):
    _plan(build.spec, done=False, qa_status="approved")

    build.run(skip_qa=True)

    assert _events(capsys.readouterr().out) == []


def test_a_paused_build_finalizes_nothing(build, capsys):
    build.mode = WorkspaceMode.ISOLATED
    build.agent_raises = BuildPaused(phase="coding", subtask_id="s2")

    build.run()

    out = capsys.readouterr().out
    assert "Paused during: coding" in out
    assert "Paused on subtask: s2" in out
    assert ("status", BuildState.PAUSED) in build.log
    assert not [entry for entry in build.log if entry[0] == "finalize"]


def test_a_plan_split_by_the_planner_removes_its_empty_worktree(build):
    build.mode = WorkspaceMode.ISOLATED
    build.agent_raises = BuildSplit("001-feature", ["001a", "001b"])

    build.run()

    assert ("remove", "001-feature", True) in build.log


def test_a_worktree_that_cannot_be_removed_after_a_split_is_left(build):
    build.mode = WorkspaceMode.ISOLATED
    build.agent_raises = BuildSplit("001-feature", ["001a", "001b"])
    build.log.insert(0, "remove-fails")

    build.run()

    assert ("remove", "001-feature", True) in build.log


def test_a_halted_phase_exits_non_zero_with_its_reason(build, capsys):
    build.agent_raises = BuildHalted("planning", "no spec to plan from")

    with pytest.raises(SystemExit) as exit_info:
        build.run()

    assert exit_info.value.code == 1
    out = capsys.readouterr().out
    assert "BUILD HALTED — phase: planning" in out
    assert "no spec to plan from" in out


def test_ctrl_c_hands_over_to_the_pause_menu(build):
    build.agent_raises = KeyboardInterrupt()

    build.run(streaming_session_id="live-1", max_iterations=7)

    assert build.interrupt["streaming_session_id"] == "live-1"
    assert build.interrupt["max_iterations"] == 7
    assert build.interrupt["spec_dir"] == build.spec


def test_a_crash_is_named_on_the_card(build, capsys):
    build.agent_raises = ValueError("plan is not JSON")

    with pytest.raises(SystemExit) as exit_info:
        build.run()

    assert exit_info.value.code == 1
    out = capsys.readouterr()
    assert "Fatal error: plan is not JSON" in out.out
    [event] = _events(out.out)
    assert event["type"] == "CODING_FAILED"
    assert event["error"] == "ValueError: plan is not JSON"


def test_an_unwritable_event_stream_does_not_fail_a_finished_build(
    build, monkeypatch, capsys
):
    import core.task_event

    _plan(build.spec, done=True, qa_status="approved")

    def unwritable(spec_dir):
        raise OSError("stdout closed")

    monkeypatch.setattr(core.task_event.TaskEventEmitter, "from_spec_dir", unwritable)

    build.run(skip_qa=True)

    assert build.observe["qa_approved"] is True
