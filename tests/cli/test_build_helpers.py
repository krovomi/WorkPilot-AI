"""The build's side steps: each reports what it did, none fails the build."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from cli import build_commands as bc
from foundation.build_signals import BuildHalted, BuildPaused


@pytest.fixture
def emitted(monkeypatch):
    import core.task_event

    seen = []

    class Emitter:
        @classmethod
        def from_spec_dir(cls, spec_dir):
            if seen and seen[-1] == "broken":
                raise OSError("read-only")
            return cls()

        def emit(self, kind, payload):
            seen.append((kind, payload))

    monkeypatch.setattr(core.task_event, "TaskEventEmitter", Emitter)
    return seen


def test_a_build_that_cannot_start_names_each_reason(tmp_path, emitted):
    bc._emit_startup_failure(tmp_path, [])
    assert emitted == []
    bc._emit_startup_failure(tmp_path, ["no token", "no spec.md"])
    [(kind, payload)] = emitted
    assert kind == "PLANNING_FAILED"
    assert payload["error"].endswith("- no token\n- no spec.md")
    assert payload["recoverable"] is True


def test_a_crash_is_named_on_the_card(tmp_path, emitted):
    bc._emit_fatal_error(tmp_path, ValueError("bad plan"))
    assert emitted == [
        (
            "CODING_FAILED",
            {"subtaskId": "", "attemptCount": 0, "error": "ValueError: bad plan"},
        )
    ]


def test_an_unwritable_event_stream_is_not_a_second_failure(tmp_path, emitted):
    emitted.append("broken")
    bc._emit_startup_failure(tmp_path, ["x"])
    bc._emit_fatal_error(tmp_path, RuntimeError("y"))
    assert emitted == ["broken"]


def test_changed_files_or_unknown():
    class Manager:
        def __init__(self, answer):
            self.answer = answer

        def get_changed_files(self, spec):
            if isinstance(self.answer, BaseException):
                raise self.answer
            return self.answer

    assert bc._changed_files(None, "s") is None
    assert bc._changed_files(Manager([("M", "a.py"), ("A", "b.py")]), "s") == [
        "a.py",
        "b.py",
    ]
    assert bc._changed_files(Manager(RuntimeError("git")), "s") is None


@pytest.mark.parametrize(
    ("declared", "writes"),
    [(None, True), (("research",), False), (("planning", "qa"), True), ((), False)],
)
def test_which_workflows_write_code(declared, writes):
    profile = None if declared is None else SimpleNamespace(declared=declared)
    assert bc._workflow_writes_code(profile) is writes


def _outcome(phase, ok, detail=""):
    return SimpleNamespace(phase_id=phase, succeeded=ok, detail=detail)


def test_a_workflow_without_coder_settles_the_card(
    tmp_path, emitted, monkeypatch, capsys
):
    import core.agent

    synced = []
    monkeypatch.setattr(
        core.agent, "sync_spec_to_source", lambda a, b: synced.append(b)
    )
    profile = SimpleNamespace(workflow="research")

    bc._conclude_without_coder(profile, SimpleNamespace(outcomes=[]), tmp_path, "src")
    assert emitted[-1] == ("QA_PASSED", {"iteration": 0, "testsRun": {}})
    assert "the phases above are the build" in capsys.readouterr().out

    run = SimpleNamespace(
        outcomes=[_outcome("survey", False, "no network"), _outcome("x", True)]
    )
    bc._conclude_without_coder(profile, run, tmp_path, "src")
    kind, payload = emitted[-1]
    assert kind == "PLANNING_FAILED"
    assert payload["error"] == "workflow 'research': survey: no network"
    assert "a phase did not run" in capsys.readouterr().out
    assert synced == ["src", "src"]


def test_settling_the_card_never_raises(tmp_path, emitted, monkeypatch, capsys):
    import core.agent

    def broken(*args):
        raise OSError("disk")

    monkeypatch.setattr(core.agent, "sync_spec_to_source", broken)
    emitted.append("broken")
    run = SimpleNamespace(outcomes=[_outcome("survey", False)])
    bc._conclude_without_coder(SimpleNamespace(workflow="w"), run, tmp_path, None)
    assert "a phase did not run" in capsys.readouterr().out


def test_spec_sync_back(tmp_path, monkeypatch):
    import agents.utils

    calls = []
    monkeypatch.setattr(
        agents.utils, "sync_spec_to_source", lambda a, b: calls.append((a, b)) or True
    )
    bc._sync_spec_back(tmp_path, None, "after qa")
    bc._sync_spec_back(tmp_path, tmp_path / "src", "after qa")
    assert calls == [(tmp_path, tmp_path / "src")]

    def broken(a, b):
        raise OSError("gone")

    monkeypatch.setattr(agents.utils, "sync_spec_to_source", broken)
    bc._sync_spec_back(tmp_path, tmp_path / "src", "after qa")


def test_the_project_and_its_language(tmp_path, monkeypatch):
    import subagents

    spec = tmp_path / ".workpilot" / "specs" / "001-x"
    assert bc._project_dir(spec) == tmp_path
    monkeypatch.setattr(subagents, "detect_languages", lambda root: ["rust", "python"])
    assert bc._primary_language(spec) == "rust"
    monkeypatch.setattr(subagents, "detect_languages", lambda root: [])
    assert bc._primary_language(spec) == ""

    def broken(root):
        raise OSError("unreadable")

    monkeypatch.setattr(subagents, "detect_languages", broken)
    assert bc._primary_language(spec) == ""


@pytest.mark.parametrize(
    ("status", "verdict"), [("pass", True), ("fail", False), ("blocked", None)]
)
def test_the_app_verification_verdict(tmp_path, monkeypatch, status, verdict):
    import verify.record

    monkeypatch.setattr(verify.record, "load_record", lambda d: {"status": status})
    assert bc._app_verified(tmp_path) is verdict


def test_no_verification_record_is_unknown(tmp_path, monkeypatch):
    import verify.record

    def broken(d):
        raise ValueError("bad json")

    monkeypatch.setattr(verify.record, "load_record", broken)
    assert bc._app_verified(tmp_path) is None


def _report(spec, rel, text):
    path = spec / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


@pytest.mark.parametrize(
    ("qa", "verify", "green"),
    [
        (None, None, None),
        ("Tests: PASS", None, True),
        (None, "All tests passed.", True),
        ("Tests: pass", "There were test failures", False),
        ("Nothing about tests", None, None),
    ],
)
def test_tests_went_green(tmp_path, qa, verify, green):
    if qa is not None:
        _report(tmp_path, "qa_report.md", qa)
    if verify is not None:
        _report(tmp_path, "workflow/verify.md", verify)
    assert bc._tests_went_green(tmp_path) is green


def test_an_unreadable_report_says_nothing(tmp_path):
    (tmp_path / "qa_report.md").mkdir()
    assert bc._verdict_in(tmp_path / "qa_report.md") is None


def test_without_engine_the_optional_steps_do_nothing(tmp_path):
    assert bc._run_deterministic_gates(None, tmp_path, tmp_path) is None
    assert bc._phase_context(None, tmp_path, tmp_path, "m", False, None) is None
    assert bc._run_workflow_phases(None, None, after=None, before=None) is None
    bc._report_hard_gates(None, tmp_path, None)
    bc._run_observe_phase(tmp_path, profile=None, qa_approved=True, ran_qa=True)


def test_an_observe_phase_the_profile_prunes(tmp_path):
    profile = SimpleNamespace(will_run=lambda phase: False)
    bc._run_observe_phase(tmp_path, profile=profile, qa_approved=True, ran_qa=True)


@pytest.mark.parametrize("raised", [RuntimeError("x"), ImportError("y")])
def test_side_steps_that_fail_are_skipped(tmp_path, monkeypatch, raised):
    import brain.learn
    import docintel
    import libdocs
    import requirement_trace

    def boom(*args, **kwargs):
        raise raised

    for module, name in [
        (libdocs, "run_preflight"),
        (docintel, "run_preflight"),
        (brain.learn, "record_build"),
    ]:
        monkeypatch.setattr(module, name, boom)
    bc._run_docs_preflight(tmp_path, tmp_path, tmp_path)
    bc._run_attachments_preflight(tmp_path, tmp_path)
    bc._record_build_in_brain(
        tmp_path, qa_approved=True, tests_passed=None, changed_files=None
    )
    if isinstance(raised, ImportError):
        monkeypatch.setattr(requirement_trace, "write_links", boom)
        bc._write_requirement_links(tmp_path, tmp_path, None, tmp_path, None)
    bc._run_convention_pass(tmp_path, SimpleNamespace(spec_id="s"), None)


def test_side_steps_report_what_they_did(tmp_path, monkeypatch, capsys):
    import brain.learn
    import docintel
    import libdocs
    import requirement_trace

    said = SimpleNamespace(describe=lambda: "did it")
    monkeypatch.setattr(libdocs, "run_preflight", lambda *a, **k: said)
    monkeypatch.setattr(docintel, "run_preflight", lambda *a, **k: said)
    monkeypatch.setattr(brain.learn, "record_build", lambda *a, **k: "builds/001.md")
    monkeypatch.setattr(
        requirement_trace,
        "write_links",
        lambda *a: {
            "requirements": [
                {"id": "FR-001", "untested": True},
                {"id": "FR-002", "untested": False},
            ]
        },
    )

    bc._run_docs_preflight(tmp_path, tmp_path, tmp_path)
    bc._run_attachments_preflight(tmp_path, tmp_path)
    bc._record_build_in_brain(
        tmp_path, qa_approved=True, tests_passed=True, changed_files=[]
    )
    bc._write_requirement_links(tmp_path, tmp_path, None, tmp_path, ["a.py"])

    out = capsys.readouterr().out
    assert out.count("did it") == 2
    assert "brain: build recorded in builds/001.md" in out
    assert "requirements: 2 linked to their files, without a test for: FR-001" in out


def test_a_branch_over_the_review_ceiling_is_flagged(tmp_path, monkeypatch, capsys):
    checks = iter(
        [
            SimpleNamespace(
                over=True,
                lines=900,
                files=30,
                max_lines=400,
                max_files=20,
                kind="feature",
            ),
            SimpleNamespace(over=False),
        ]
    )
    monkeypatch.setattr(bc, "record_diff_check", lambda dirs, wd, base: next(checks))

    bc._check_review_load(tmp_path, tmp_path, tmp_path, "develop")
    bc._check_review_load(tmp_path, tmp_path, tmp_path, "develop")

    out = capsys.readouterr().out
    assert out.count("lines to review") == 1
    assert "about 900 lines to review in 30 files" in out


def test_the_profile_is_announced_with_its_missing_phases(
    tmp_path, monkeypatch, capsys
):
    import workflows

    profile = SimpleNamespace(
        describe=lambda: "workflow feature-build",
        will_run=lambda phase: phase == "review",
    )
    monkeypatch.setattr(workflows, "resolve_profile", lambda *a, **k: profile)
    monkeypatch.setattr(
        workflows,
        "validate_impls",
        lambda wf, available, gated: [
            SimpleNamespace(phase_id="review", reason="pack not installed"),
            SimpleNamespace(phase_id="design-check", reason="pruned anyway"),
        ],
    )

    assert bc._resolve_workflow_profile(tmp_path) is profile

    out = capsys.readouterr().out
    assert "workflow feature-build" in out
    assert "⚠ review: pack not installed" in out
    assert "design-check" not in out


def test_unreadable_packs_and_checks_only_cost_a_line(tmp_path, monkeypatch, capsys):
    import skills_registry.packs

    import workflows

    profile = SimpleNamespace(describe=lambda: "plan", will_run=lambda phase: True)
    monkeypatch.setattr(workflows, "resolve_profile", lambda *a, **k: profile)

    def unreadable(*args, **kwargs):
        raise OSError("skills/ is gone")

    monkeypatch.setattr(workflows, "validate_impls", unreadable)
    assert bc._resolve_workflow_profile(tmp_path) is profile
    assert "could not check phase implementations" in capsys.readouterr().out

    monkeypatch.setattr(skills_registry.packs, "load_packs", unreadable)
    assert bc._resolve_workflow_profile(tmp_path) is profile
    assert "could not read the installed packs: skills/ is gone" in (
        capsys.readouterr().out
    )
    # The second resolution says nothing, whatever it could not read.
    assert bc._resolve_workflow_profile(tmp_path, [], announce=False) is profile
    assert capsys.readouterr().out == ""


def test_a_broken_engine_runs_the_build_without_it(tmp_path, monkeypatch, capsys):
    import workflows

    def broken(*args, **kwargs):
        raise ValueError("workflow.yaml is invalid")

    monkeypatch.setattr(workflows, "resolve_profile", broken)

    assert bc._resolve_workflow_profile(tmp_path) is None
    assert "Workflow engine disabled for this run: workflow.yaml is invalid" in (
        capsys.readouterr().out
    )
    assert bc._resolve_workflow_profile(tmp_path, announce=False) is None
    assert capsys.readouterr().out == ""


@pytest.mark.parametrize("flag", ["0", "off", " No "])
def test_the_engine_can_be_switched_off(tmp_path, monkeypatch, flag):
    monkeypatch.setenv("WORKPILOT_WORKFLOW_ENGINE", flag)
    assert bc._resolve_workflow_profile(tmp_path) is None


def test_deterministic_gates_report_or_step_aside(tmp_path, monkeypatch, capsys):
    import workflows

    run = SimpleNamespace(describe=lambda: "gates: 2 clean")
    monkeypatch.setattr(workflows, "run_deterministic_gates", lambda p, wd, packs: run)
    assert bc._run_deterministic_gates(object(), tmp_path, tmp_path) is run
    assert "gates: 2 clean" in capsys.readouterr().out

    def broken(*args):
        raise RuntimeError("linter missing")

    monkeypatch.setattr(workflows, "run_deterministic_gates", broken)
    assert bc._run_deterministic_gates(object(), tmp_path, tmp_path) is None


def test_a_missing_docs_package_skips_the_preflight(tmp_path, monkeypatch):
    import sys

    monkeypatch.setitem(sys.modules, "libdocs", None)
    bc._run_docs_preflight(tmp_path, tmp_path, tmp_path)


def test_the_dotnet_preflight_prints_only_what_it_found(tmp_path, monkeypatch, capsys):
    import dotnet_upgrade

    said = iter(["net10.0 → net11.0: 3 projects", ""])
    monkeypatch.setattr(
        dotnet_upgrade,
        "run_preflight",
        lambda wd, spec: SimpleNamespace(describe=lambda: next(said)),
    )

    bc._run_dotnet_preflight(tmp_path, tmp_path)
    bc._run_dotnet_preflight(tmp_path, tmp_path)

    assert capsys.readouterr().out == "\nnet10.0 → net11.0: 3 projects\n"


def test_an_unbuildable_phase_context_disables_the_phases(tmp_path, monkeypatch):
    import workflows

    def broken(**kwargs):
        raise TypeError("unexpected field")

    monkeypatch.setattr(workflows, "PhaseContext", broken)
    profile = SimpleNamespace(effort="high")
    assert bc._phase_context(profile, tmp_path, tmp_path, "m", False, None) is None


def test_skill_phases_report_and_never_fail_the_build(tmp_path, monkeypatch, capsys):
    import workflows

    outcomes = iter(
        [
            SimpleNamespace(describe=lambda: "review: 1 finding"),
            RuntimeError("runner crashed"),
            BuildPaused("review"),
            BuildHalted("review", "no diff"),
        ]
    )

    async def run_skill_phases(profile, ctx, *, after, before):
        outcome = next(outcomes)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    monkeypatch.setattr(workflows, "run_skill_phases", run_skill_phases)
    profile, ctx = object(), object()

    run = bc._run_workflow_phases(profile, ctx, after="coding", before="qa")
    assert "review: 1 finding" in capsys.readouterr().out
    assert run.describe() == "review: 1 finding"
    assert bc._run_workflow_phases(profile, ctx, after="coding", before="qa") is None
    # A pause or a halt is the user's or the phase's decision, not a failure.
    with pytest.raises(BuildPaused):
        bc._run_workflow_phases(profile, ctx, after="coding", before="qa")
    with pytest.raises(BuildHalted):
        bc._run_workflow_phases(profile, ctx, after="coding", before="qa")


def test_observation_that_fails_is_skipped(tmp_path, monkeypatch):
    import learning_loop.observe

    def broken(*args):
        raise RuntimeError("ledger locked")

    monkeypatch.setattr(learning_loop.observe, "run_observe", broken)
    profile = SimpleNamespace(will_run=lambda phase: True, workflow="feature-build")
    spec = tmp_path / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)

    bc._run_observe_phase(spec, profile=profile, qa_approved=True, ran_qa=False)


def test_the_convention_pass_reports_what_it_learned(tmp_path, monkeypatch, capsys):
    import learning_loop.conventions

    seen = {}

    def run_convention_pass(project, changed, signals, spec_id):
        seen.update(project=project, changed=changed, spec_id=spec_id)
        return 2, [tmp_path / "naming.md"]

    monkeypatch.setattr(
        learning_loop.conventions, "run_convention_pass", run_convention_pass
    )
    spec = tmp_path / ".workpilot" / "specs" / "001-x"
    spec.mkdir(parents=True)
    outcome = SimpleNamespace(
        spec_id="001-x",
        qa_approved=True,
        tests_passed=True,
        detector_clean=None,
        pr_merged=None,
        app_verified=None,
    )

    bc._run_convention_pass(spec, outcome, ["src/a.py"])
    bc._run_convention_pass(spec, outcome, [])  # touched nothing: no evidence

    out = capsys.readouterr().out
    assert "conventions: 2 observation(s) recorded" in out
    assert "proposed  conventions/_proposed/naming.md" in out
    assert seen == {"project": tmp_path, "changed": ["src/a.py"], "spec_id": "001-x"}


def test_hard_gates_say_when_the_branch_is_not_ready(tmp_path, monkeypatch, capsys):
    import workflows.hard_gates as hard_gates

    reports = iter(
        [
            SimpleNamespace(describe=lambda: "tests-pass: failed", blocking=True),
            RuntimeError("no record"),
        ]
    )
    written = []

    def evaluate(profile, spec_dir, *, tests_passed, changed_files):
        report = next(reports)
        if isinstance(report, BaseException):
            raise report
        return report

    monkeypatch.setattr(hard_gates, "evaluate_hard_gates", evaluate)
    monkeypatch.setattr(
        hard_gates, "write_gate_record", lambda spec, report: written.append(report)
    )

    bc._report_hard_gates(object(), tmp_path, False, ["a.py"])
    bc._report_hard_gates(object(), tmp_path, None)

    out = capsys.readouterr().out
    assert "tests-pass: failed" in out
    assert "the branch is not ready to merge on this evidence" in out
    assert len(written) == 1


def test_an_unreadable_verdict_is_unknown(tmp_path, monkeypatch):
    report = tmp_path / "qa_report.md"
    report.write_text("Tests: PASS", encoding="utf-8")

    def unreadable(self, *args, **kwargs):
        raise PermissionError("locked")

    monkeypatch.setattr(type(report), "read_text", unreadable)
    assert bc._verdict_in(report) is None


def test_a_convention_pass_that_fails_is_skipped(tmp_path, monkeypatch, capsys):
    import learning_loop.conventions

    def broken(*args):
        raise RuntimeError("ledger locked")

    monkeypatch.setattr(learning_loop.conventions, "run_convention_pass", broken)
    outcome = SimpleNamespace(
        spec_id="001-x",
        qa_approved=None,
        tests_passed=None,
        detector_clean=None,
        pr_merged=None,
        app_verified=None,
    )

    bc._run_convention_pass(tmp_path / "a" / "b" / "c", outcome, ["src/a.py"])
    assert "conventions" not in capsys.readouterr().out


def test_a_build_that_skipped_qa_is_held_to_its_goal(tmp_path, monkeypatch, capsys):
    import goal

    recorded = []
    verdicts = {
        "met": SimpleNamespace(met=True, reason="the endpoint answers"),
        "unmet": SimpleNamespace(met=False, reason="3 tests still fail"),
    }
    monkeypatch.setattr(goal, "read_goal", lambda spec, source: (spec.name, None))
    monkeypatch.setattr(goal, "evaluate_goal", lambda g, wd, spec, source: verdicts[g])
    monkeypatch.setattr(
        goal, "record_verdict", lambda verdict, spec: recorded.append(verdict)
    )

    assert bc._goal_allows_done(tmp_path, tmp_path / "met", None) is True
    assert bc._goal_allows_done(tmp_path, tmp_path / "unmet", None) is False

    out = capsys.readouterr().out
    assert "🎯 Goal met: the endpoint answers" in out
    assert "🎯 Goal not met: 3 tests still fail" in out
    assert recorded == [verdicts["met"], verdicts["unmet"]]


def test_an_unreadable_goal_is_not_met(tmp_path, monkeypatch):
    import goal

    invalid = SimpleNamespace(met=False, reason="goal.yaml is not YAML")
    monkeypatch.setattr(goal, "read_goal", lambda spec, source: (None, invalid))
    monkeypatch.setattr(goal, "record_verdict", lambda verdict, spec: None)

    assert bc._goal_allows_done(tmp_path, tmp_path, None) is False
