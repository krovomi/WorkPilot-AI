"""The QA loop's edges: what `test_qa_loop_characterization.py` does not pin.

The same harness drives the real loop with scripted sessions, for the paths
a run takes without a task log, with a Linear task, with a local model that
never called a tool, or when the cost budget, the visual QA or a goal step
in. The helpers each pass calls (the security scan, the project without
tests, the hot swap, jev, the re-review section, the change scope, the
gates around the approval) are called directly with a scope of their own,
for every way they give up without stopping QA.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest
import qa.loop as loop
from foundation.build_signals import BuildPaused
from foundation.change_scope import ChangeScope

from tests.test_qa_loop_characterization import (
    _Client,
    _Emitter,
    _issue,
    _Logger,
    _plan,
    _sign_off,
)
from tests.test_qa_loop_characterization import (
    harness as harness,  # the fixture, re-exported for this module
)


@pytest.fixture(autouse=True)
def _current_modules():
    """The conftest re-imports protected packages between files: patch and
    compare against the modules the loop will use, not the collected ones."""
    global loop, ChangeScope, BuildPaused
    import foundation.build_signals as signals
    import foundation.change_scope as change
    import qa.loop as current

    loop, ChangeScope, BuildPaused = current, change.ChangeScope, signals.BuildPaused


def _scope(tmp_path: Path, *, logger=None, linear=None, emitter=None) -> loop._QaScope:
    spec = tmp_path / "spec"
    spec.mkdir(exist_ok=True)
    return loop._QaScope(
        project_dir=tmp_path,
        spec_dir=spec,
        source_spec_dir=None,
        verbose=False,
        task_logger=logger,
        emitter=emitter or _Emitter(),
        linear_task=linear,
        max_iterations=3,
        recurring_threshold=3,
    )


@pytest.fixture
def no_log(harness, monkeypatch):
    monkeypatch.setattr(loop, "get_task_logger", lambda _spec: None)
    return harness


@pytest.fixture
def linear(harness, monkeypatch):
    calls: list[tuple] = []

    def record(name):
        async def call(*args):
            calls.append((name, *args[1:]))

        return call

    monkeypatch.setattr(loop, "is_linear_enabled", lambda: True)
    monkeypatch.setattr(
        loop.LinearTaskState,
        "load",
        staticmethod(lambda _spec: types.SimpleNamespace(task_id="LIN-1")),
    )
    for name in ("started", "approved", "rejected", "max_iterations"):
        monkeypatch.setattr(loop, f"linear_qa_{name}", record(name))
    harness.linear = calls
    return harness


# --- whole runs ---------------------------------------------------------------------


class TestWithoutATaskLog:
    async def test_an_approval(self, no_log):
        no_log.reviews = [("approved", [])]
        assert await no_log.run() is True

    async def test_a_fix_then_an_approval(self, no_log):
        no_log.reviews = [("rejected", [_issue("Flaw")]), ("approved", [])]
        assert await no_log.run() is True
        assert [i for i, _ in no_log.fixer_calls] == [1]

    async def test_a_recurring_issue(self, no_log):
        no_log.threshold = 2
        no_log.cap = 5
        no_log.reviews = [("rejected", [_issue("Same flaw")])] * 2
        assert await no_log.run() is False
        assert (no_log.spec_dir / "QA_ESCALATION.md").exists()

    async def test_three_errors(self, no_log):
        no_log.reviews = [("error", f"failure {n}") for n in range(3)]
        assert await no_log.run() is False

    async def test_a_human_escalation_lists_the_next_steps(
        self, no_log, monkeypatch, capsys
    ):
        steps = [f"step {n}" for n in range(7)]
        real = loop.get_qa_signoff_status
        monkeypatch.setattr(
            loop,
            "get_qa_signoff_status",
            lambda spec: {**(real(spec) or {}), "next_steps": steps},
        )
        no_log.reviews = [("human_escalation", [])]
        assert await no_log.run() is True
        out = capsys.readouterr().out
        assert "  - step 4" in out and "step 5" not in out

    async def test_the_budget_runs_out_with_the_files_to_read(
        self, no_log, monkeypatch, capsys
    ):
        no_log.cap = 2
        (no_log.spec_dir / "qa_report.md").write_text("# QA", encoding="utf-8")
        monkeypatch.setattr(
            loop,
            "get_recurring_issue_summary",
            lambda history: {"total_issues": 0, "unique_issues": 0, "most_common": []},
        )
        no_log.reviews = [("rejected", [_issue(f"Flaw {n}")]) for n in range(2)]
        assert await no_log.run() is False
        out = capsys.readouterr().out
        assert "📊 Iteration Summary" not in out
        assert f"See: {no_log.spec_dir / 'QA_FIX_REQUEST.md'}" in out
        assert f"See: {no_log.spec_dir / 'qa_report.md'}" in out

    async def test_a_budget_spent_before_this_run_reviews_nothing(
        self, harness, monkeypatch, capsys
    ):
        for _ in range(3):
            _sign_off(harness.spec_dir, "rejected", [_issue("Old flaw")])
        monkeypatch.setattr(
            loop,
            "get_recurring_issue_summary",
            lambda history: {"total_issues": 1, "unique_issues": 1, "most_common": []},
        )
        assert await harness.run() is False
        assert harness.review_calls == []
        out = capsys.readouterr().out
        assert "Total issues found: 1" in out and "Most common" not in out


class TestWithALinearTask:
    async def test_the_task_moves_with_each_verdict(self, linear):
        linear.reviews = [("rejected", [_issue("Flaw")]), ("approved", [])]
        assert await linear.run() is True
        assert linear.linear == [
            ("started",),
            ("rejected", 1, 1),
            ("approved",),
        ]

    async def test_a_human_escalation_is_an_approval_there(self, linear):
        linear.reviews = [("human_escalation", [])]
        assert await linear.run() is True
        assert linear.linear[-1] == ("approved",)

    async def test_a_recurring_issue_needs_a_person(self, linear):
        linear.threshold = 2
        linear.cap = 5
        linear.reviews = [("rejected", [_issue("Same flaw")])] * 2
        assert await linear.run() is False
        assert linear.linear[-1] == ("max_iterations", 2)

    async def test_the_budget_running_out_needs_a_person(self, linear):
        linear.cap = 1
        linear.reviews = [("rejected", [_issue("Flaw")])]
        assert await linear.run() is False
        assert linear.linear[-1] == ("max_iterations", 1)

    async def test_no_task_id_no_move(self, harness, monkeypatch):
        monkeypatch.setattr(loop, "is_linear_enabled", lambda: True)
        monkeypatch.setattr(
            loop.LinearTaskState, "load", staticmethod(lambda _spec: None)
        )
        assert await loop._start_linear_review(harness.spec_dir) is None


class TestWhatStopsAPass:
    async def test_a_stale_halt_marker_is_cleared(self, harness):
        from services.rate_limit_shield import LOCAL_MODEL_NO_TOOLS_HALT_FILE

        marker = harness.spec_dir / LOCAL_MODEL_NO_TOOLS_HALT_FILE
        marker.write_text("halted", encoding="utf-8")
        harness.reviews = [("approved", [])]
        assert await harness.run() is True
        assert not marker.exists()

    async def test_a_marker_that_cannot_be_removed_is_left(self, harness):
        from services.rate_limit_shield import LOCAL_MODEL_NO_TOOLS_HALT_FILE

        (harness.spec_dir / LOCAL_MODEL_NO_TOOLS_HALT_FILE).mkdir()
        harness.reviews = [("approved", [])]
        assert await harness.run() is True

    async def test_the_cost_budget_pauses_before_a_pass(self, harness, monkeypatch):
        monkeypatch.setattr(loop, "check_before_session", lambda *_a: "over budget")
        with pytest.raises(BuildPaused):
            await harness.run()
        assert harness.review_calls == []

    async def test_the_policy_pauses_before_a_pass(self, harness, monkeypatch):
        # Outside the hours or past the token budget of workpilot.policy.yaml.
        monkeypatch.setattr(
            loop, "policy_pause_before_session", lambda *_a: "policy_hours"
        )
        with pytest.raises(BuildPaused):
            await harness.run()
        assert harness.review_calls == []

    async def test_the_visual_qa_counts_are_shown(self, harness, monkeypatch, capsys):
        monkeypatch.setattr(
            loop, "run_visual_qa", lambda *_a: {"high": 1, "medium": 0, "low": 2}
        )
        harness.reviews = [("approved", [])]
        assert await harness.run() is True
        assert (
            "🖼  Visual QA: 1 high, 0 medium, 2 low finding(s)"
            in capsys.readouterr().out
        )

    @pytest.mark.parametrize("logged", [True, False])
    async def test_a_local_model_that_never_called_a_tool_halts(
        self, harness, monkeypatch, logged
    ):
        import services.rate_limit_shield as shield

        if not logged:
            monkeypatch.setattr(loop, "get_task_logger", lambda _spec: None)
        monkeypatch.setattr(shield, "handle_local_model_no_tools", lambda *_a: True)
        harness.reviews = [("approved", [])]
        assert await harness.run() is False
        (error,) = harness.emitter.payloads("QA_AGENT_ERROR")
        assert error["reason"] == "local_model_no_tools"
        assert "« test-model »" in error["error"]
        if logged:
            assert harness.logger.phase_end["success"] is False

    async def test_a_verdict_that_is_none_of_the_four_goes_on(self, harness):
        harness.reviews = [("fixes_applied", []), ("approved", [])]
        assert await harness.run() is True
        assert harness.fixer_calls == []
        assert [c["iteration"] for c in harness.review_calls] == [1, 2]

    async def test_three_errors_from_a_local_model_name_the_model(
        self, harness, monkeypatch
    ):
        monkeypatch.setattr(
            _Client, "provider_name", lambda self: "ollama", raising=False
        )
        harness.reviews = [("error", f"failure {n}") for n in range(3)]
        assert await harness.run() is False
        assert (
            "The local model « test-model » likely can't"
            in (harness.logger.phase_end["message"])
        )


class TestTheFixer:
    async def test_a_fixer_prompt_too_long_halts(self, harness, monkeypatch):
        import services.rate_limit_shield as shield

        monkeypatch.setattr(shield, "handle_prompt_too_long", lambda *_a: True)
        harness.reviews = [("rejected", [_issue("Flaw")])]
        harness.fixes = [RuntimeError("prompt is too long")]
        assert await harness.run() is False
        assert harness.logger.phase_end == {
            "success": False,
            "message": "QA fixer halted: prompt too long for the LLM context window",
        }

    async def test_a_crashed_fixer_session_is_a_fixer_error(self, harness, monkeypatch):
        async def not_limited(*_a):
            return False

        monkeypatch.setattr(loop, "_handle_rate_limit_in_qa", not_limited)
        harness.reviews = [("rejected", [_issue("Flaw")])]
        harness.fixes = [RuntimeError("socket closed")]
        assert await harness.run() is False
        assert _plan(harness.spec_dir)["qa_iteration_history"][-1]["status"] == "error"


class TestHumanFeedback:
    @pytest.fixture
    def feedback(self, harness):
        (harness.spec_dir / "QA_FIX_REQUEST.md").write_text("# Fix", encoding="utf-8")
        return harness

    async def test_a_fixer_client_that_cannot_be_built(self, feedback):
        feedback.client_errors["qa_fixer"] = RuntimeError("no credentials")
        assert await feedback.run() is False
        assert feedback.emitter.payloads("QA_AGENT_ERROR") == [
            {"iteration": 0, "consecutiveErrors": 1, "error": "no credentials"}
        ]

    async def test_a_crashed_fixer_session(self, feedback):
        feedback.fixes = [RuntimeError("socket closed")]
        assert await feedback.run() is False
        assert feedback.review_calls == []

    async def test_a_request_that_cannot_be_removed_is_left(
        self, feedback, monkeypatch
    ):
        async def fixer(_client, spec, iteration, _verbose):
            (spec / "QA_FIX_REQUEST.md").unlink()
            (spec / "QA_FIX_REQUEST.md").mkdir()  # cannot be unlinked as a file
            return "fixed", "ok"

        monkeypatch.setattr(loop, "run_qa_fixer_session", fixer)
        feedback.reviews = [("approved", [])]
        assert await feedback.run() is True
        assert (feedback.spec_dir / "QA_FIX_REQUEST.md").is_dir()


class TestAGoal:
    async def test_a_human_escalation_records_where_the_goal_stands(
        self, harness, monkeypatch
    ):
        recorded = []
        goal = types.SimpleNamespace(max_rounds=None)
        monkeypatch.setattr(loop, "read_goal", lambda *_a: (goal, None))
        monkeypatch.setattr(loop, "budget_exceeded", lambda *_a: None)
        monkeypatch.setattr(loop, "evaluate_goal", lambda *_a: "verdict")
        monkeypatch.setattr(loop, "record_verdict", lambda v, s: recorded.append(v))
        harness.reviews = [("human_escalation", [])]
        assert await harness.run() is True
        assert recorded == ["verdict"]

    def test_a_goal_stop_without_a_task_log(self, tmp_path, monkeypatch):
        monkeypatch.setattr(loop, "record_verdict", lambda *_a: None)
        scope = _scope(tmp_path)
        verdict = types.SimpleNamespace(reason="cap reached")
        assert (
            loop._stop_on_goal(scope, loop._QaState(qa_iteration=2), verdict) is False
        )
        assert scope.emitter.names == ["QA_MAX_ITERATIONS"]

    def test_no_plan_no_signoff_to_reject(self, tmp_path):
        loop._reject_signoff_for_goal(tmp_path, [{"type": "goal"}])
        assert not (tmp_path / "implementation_plan.json").exists()

    def test_a_goal_rejection_without_its_fix_request_file(self, tmp_path, monkeypatch):
        scope = _scope(tmp_path)
        (scope.spec_dir / "QA_FIX_REQUEST.md").mkdir()
        (scope.spec_dir / "implementation_plan.json").write_text(
            json.dumps({"qa_signoff": {"status": "approved"}}), encoding="utf-8"
        )
        verdict = types.SimpleNamespace(
            met=False,
            fixable=True,
            reason="exit 1",
            issues=lambda: [{"type": "goal", "title": "not met"}],
        )
        monkeypatch.setattr(loop, "evaluate_goal", lambda *_a: verdict)
        monkeypatch.setattr(loop, "fix_request", lambda *_a: "# Goal")
        monkeypatch.setattr(loop, "record_verdict", lambda *_a: None)
        issues, message = loop._goal_gate(scope, loop._QaState(qa_iteration=2), None)
        assert message == "QA pass #2 rejected by the goal gate"
        assert _plan(scope.spec_dir)["qa_signoff"]["status"] == "rejected"


# --- the helpers of a pass --------------------------------------------------------------


class TestTheSecurityScan:
    async def test_findings_are_counted_and_sent_to_the_card(
        self, tmp_path, monkeypatch
    ):
        issues = [
            {"type": "critical"},
            {"type": "high"},
            {"type": "high"},
            {"type": "low"},
        ]

        from security_reach import evidence_for

        ranked_with = []

        async def scan(*_a, evidence=None):
            ranked_with.append(evidence)
            return False, None, issues

        monkeypatch.setattr(loop, "run_qa_security_scan", scan)
        emitter = _Emitter()
        await loop._run_security_scan(tmp_path, tmp_path, emitter)
        assert emitter.events == [
            ("SECURITY_SCAN_ISSUES", {"critical": 1, "high": 2, "issues": issues})
        ]
        # The findings are ranked by reach and production use (#364).
        assert ranked_with == [evidence_for]

    async def test_a_broken_opinion_producer_does_not_stop_it(
        self, tmp_path, monkeypatch
    ):
        import consensus_arbiter.opinion_writer as writer

        async def scan(*_a, evidence=None):
            return True, None, []

        def broken(*_a):
            raise RuntimeError("arbiter down")

        monkeypatch.setattr(loop, "run_qa_security_scan", scan)
        monkeypatch.setattr(writer, "record_security_opinions", broken)
        await loop._run_security_scan(tmp_path, tmp_path, _Emitter())

    async def test_a_scan_that_crashes_is_skipped(self, tmp_path, monkeypatch, capsys):
        async def scan(*_a, evidence=None):
            raise RuntimeError("scanner missing")

        monkeypatch.setattr(loop, "run_qa_security_scan", scan)
        await loop._run_security_scan(tmp_path, tmp_path, _Emitter())
        assert "Security scan skipped: scanner missing" in capsys.readouterr().out


class TestAProjectWithoutTests:
    @pytest.fixture
    def untested(self, tmp_path, monkeypatch):
        monkeypatch.setattr(loop, "is_no_test_project", lambda *_a: True)
        spec = tmp_path / "spec"
        spec.mkdir()
        return tmp_path, spec

    def _dotnet(self, monkeypatch, detected: bool, run=None):
        import foundation.dotnet_tools as tools

        monkeypatch.setattr(tools, "detect_dotnet_project", lambda _p: detected)

        async def tests(_project):
            return run

        monkeypatch.setattr(loop, "_run_dotnet_tests", tests)

    async def test_a_project_with_tests_needs_nothing(self, tmp_path, monkeypatch):
        monkeypatch.setattr(loop, "is_no_test_project", lambda *_a: False)
        assert await loop._prepare_no_test_project(tmp_path, tmp_path) == ""

    async def test_without_dotnet_a_manual_plan_is_written(self, untested, monkeypatch):
        project, spec = untested
        self._dotnet(monkeypatch, False)
        assert await loop._prepare_no_test_project(project, spec) == ""
        assert (spec / "MANUAL_TEST_PLAN.md").exists()

    @pytest.mark.parametrize(
        ("status", "plan"),
        [("passed", False), ("failed", False), ("unavailable", True)],
    )
    async def test_dotnet_test_is_run_and_the_reviewer_told(
        self, untested, monkeypatch, status, plan
    ):
        project, spec = untested
        run = loop.DotnetTestRun(
            status, "Failed AppTests.Adds" if status == "failed" else "x"
        )
        self._dotnet(monkeypatch, True, run)
        advice = await loop._prepare_no_test_project(project, spec)
        assert advice == loop.dotnet_test_advice(run, spec)
        assert (spec / "MANUAL_TEST_PLAN.md").exists() is plan


class TestTheHotSwap:
    @pytest.fixture
    def swap(self, monkeypatch):
        import agents.hot_swap as hot_swap

        applied = []
        monkeypatch.setattr(
            hot_swap, "consume_hot_swap_for_phase", lambda s, p: {"model": "m2"}
        )
        monkeypatch.setattr(
            hot_swap, "apply_hot_swap_to_metadata", lambda s, r: applied.append(r)
        )
        monkeypatch.setattr(hot_swap, "describe_hot_swap", lambda r: "QA now uses m2")
        return applied

    def test_a_pending_swap_is_applied_and_logged(self, tmp_path, swap):
        logger = _Logger()
        loop._apply_qa_hot_swap(tmp_path, logger)
        loop._apply_qa_hot_swap(tmp_path, None)
        assert swap == [{"model": "m2"}, {"model": "m2"}]
        assert logger.named("log_info") == [(("QA now uses m2",), {})]

    def test_a_swap_that_fails_never_breaks_qa(self, tmp_path, monkeypatch, swap):
        import agents.hot_swap as hot_swap

        def broken(s, r):
            raise RuntimeError("bad marker")

        monkeypatch.setattr(hot_swap, "apply_hot_swap_to_metadata", broken)
        loop._apply_qa_hot_swap(tmp_path, None)


class TestJev:
    async def test_a_base_that_cannot_be_captured(self, tmp_path, monkeypatch):
        import foundation.base_branch as base_branch
        import integrations.jev.adapters as adapters
        import integrations.jev.rubrics as rubrics

        class Run:
            def eligibility(self):
                return None

        def capture(run, base):
            raise OSError("no git")

        async def assess(run, step, *, pass_id):
            return pass_id

        monkeypatch.setattr(base_branch, "detect_base_branch", lambda *_a: "main")
        monkeypatch.setattr(adapters, "capture_base", capture)
        monkeypatch.setattr(adapters, "assess_build", assess)
        monkeypatch.setattr(rubrics, "advice_text", lambda outcome: f"advice {outcome}")
        run = Run()
        assert await loop._jev_review_advice(run, tmp_path, tmp_path, 2) == (
            run,
            "advice qa-2",
        )
        assert run.base_revision is None


class TestTheReReviewSection:
    FULL = ChangeScope("full", "code")

    def test_a_light_review_needs_none(self, tmp_path):
        assert (
            loop._recheck_advice(_scope(tmp_path), 2, ChangeScope("light", "t")) == ""
        )

    def test_a_section_that_cannot_be_built(self, tmp_path, monkeypatch):
        def broken(*_a):
            raise OSError("git failed")

        monkeypatch.setattr(loop.recheck, "recheck_section", broken)
        assert loop._recheck_advice(_scope(tmp_path), 2, self.FULL) == ""

    def test_a_section_is_announced_in_the_task_log(self, tmp_path, monkeypatch):
        monkeypatch.setattr(loop.recheck, "recheck_section", lambda *_a: "## RE-REVIEW")
        logger = _Logger()
        assert loop._recheck_advice(_scope(tmp_path, logger=logger), 3, self.FULL) == (
            "## RE-REVIEW"
        )
        assert "checking the fix of pass 2 first" in logger.named("log")[0][0][0]
        assert loop._recheck_advice(_scope(tmp_path), 3, self.FULL) == "## RE-REVIEW"


class TestTheChangeScope:
    def _with(self, monkeypatch, result):
        def scope(project, base):
            if isinstance(result, BaseException):
                raise result
            return result

        monkeypatch.setattr(loop, "detect_base_branch", lambda *_a: "main")
        monkeypatch.setattr(loop, "change_scope", scope)

    def test_an_unknown_change_set_is_a_full_review(self, tmp_path, monkeypatch):
        self._with(monkeypatch, OSError("no git"))
        assert loop._review_scope(_scope(tmp_path)) == ChangeScope(
            "full", "change scope unavailable"
        )

    @pytest.mark.parametrize(
        ("change", "said"),
        [
            (
                ChangeScope("light", "no change"),
                "the reviewer checks whether the repository",
            ),
            (
                ChangeScope(
                    "targeted", "2 files", files=("a.py",), tests=("tests/test_a.py",)
                ),
                "runs only tests/test_a.py",
            ),
        ],
    )
    def test_what_the_task_log_is_told(self, tmp_path, monkeypatch, change, said):
        self._with(monkeypatch, change)
        logger = _Logger()
        assert loop._review_scope(_scope(tmp_path, logger=logger)) is change
        assert said in logger.named("log")[0][0][0]
        assert loop._review_scope(_scope(tmp_path)) is change

    def test_a_prompt_too_long_without_a_task_log(self, tmp_path, monkeypatch):
        import services.rate_limit_shield as shield

        monkeypatch.setattr(shield, "handle_prompt_too_long", lambda *_a: True)
        assert loop._halted_on_prompt_too_long(
            _scope(tmp_path), RuntimeError("too long"), "halted", "phase"
        )


def test_a_broken_reviewer_opinion_producer_does_not_stop_qa(tmp_path, monkeypatch):
    import consensus_arbiter.opinion_writer as writer

    def broken(*_a, **_k):
        raise RuntimeError("arbiter down")

    monkeypatch.setattr(writer, "record_qa_reviewer_opinion", broken)
    loop._record_reviewer_opinion(tmp_path, tmp_path, "approved")


# --- the gates around the approval ------------------------------------------------------


class TestTheArchitectureGate:
    def _validator(self, monkeypatch, result):
        async def run(**_kwargs):
            if isinstance(result, BaseException):
                raise result
            return result

        validator = types.ModuleType("architecture.validator")
        validator.run_architecture_validation = run
        validator.write_architecture_fix_request = lambda *_a: None
        package = types.ModuleType("architecture")
        package.validator = validator
        monkeypatch.setitem(sys.modules, "architecture", package)
        monkeypatch.setitem(sys.modules, "architecture.validator", validator)

    async def test_a_violation_without_a_plan_still_rejects(
        self, tmp_path, monkeypatch
    ):
        self._validator(
            monkeypatch, (False, {"violations": [{"description": "cycle"}]})
        )
        issues, message = await loop._architecture_gate(_scope(tmp_path), 2, "m")
        assert issues == [
            {
                "title": "Architecture: violation",
                "description": "cycle",
                "type": "architecture_violation",
            }
        ]
        assert message == "QA pass #2 rejected: 1 architecture violation(s)"

    async def test_without_the_package_it_is_skipped(self, tmp_path, monkeypatch):
        monkeypatch.setitem(sys.modules, "architecture.validator", None)
        assert await loop._architecture_gate(_scope(tmp_path), 1, "m") is None

    async def test_a_validation_that_crashes_is_skipped(self, tmp_path, monkeypatch):
        self._validator(monkeypatch, RuntimeError("archify crashed"))
        assert await loop._architecture_gate(_scope(tmp_path), 1, "m") is None


class TestTheCoverageGate:
    def _report(self, monkeypatch, report):
        import qa.coverage_gate as gate

        def run(_spec):
            if isinstance(report, BaseException):
                raise report
            return report

        monkeypatch.setattr(gate, "run_coverage_gate", run)

    def test_windev_code_has_no_coverage_to_measure(self, tmp_path):
        scope = ChangeScope("full", "code", files=("Window.wdw",))
        assert loop._coverage_gate(tmp_path, 1, scope) is None

    def test_a_passing_report_without_warnings(self, tmp_path, monkeypatch):
        self._report(monkeypatch, {"enabled": True, "warnings": [], "passed": True})
        assert loop._coverage_gate(tmp_path, 1) is None

    def test_without_the_gate_it_is_skipped(self, tmp_path, monkeypatch):
        monkeypatch.setitem(sys.modules, "qa.coverage_gate", None)
        assert loop._coverage_gate(tmp_path, 1) is None

    def test_a_gate_that_crashes_is_skipped(self, tmp_path, monkeypatch):
        self._report(monkeypatch, RuntimeError("bad signoff"))
        assert loop._coverage_gate(tmp_path, 1) is None


def test_a_targeted_gate_that_cannot_check_rejects(tmp_path, monkeypatch):
    import qa.targeted_gate as targeted

    def broken(*_a):
        raise OSError("no signoff")

    monkeypatch.setattr(targeted, "run_targeted_gate", broken)
    scope = ChangeScope("targeted", "one file", files=("a.py",), tests=("t.py",))
    issues, message = loop._coverage_gate(tmp_path, 4, scope, [])
    assert issues[0]["type"] == "targeted_qa_gap"
    assert "no signoff" in issues[0]["description"]
    assert message == "QA pass #4 rejected by the targeted QA gate"
