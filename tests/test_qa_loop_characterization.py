"""What the QA loop does on each verdict, pinned before it is split.

`run_qa_validation_loop` is one function of more than a thousand lines: a
reviewer pass, two gates that can overturn its approval, a fixer, and the
error, rate-limit and escalation branches between them. These tests drive
the real loop with scripted reviewer and fixer sessions and record what a
caller can see: the return value, the task events, the iteration history,
the fixer's calls and the task log. They were written green against the
loop before its split, and the split keeps them green.
"""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path

import pytest
from foundation.build_signals import BuildPaused


class _Logger:
    """Task logger double: records every call by name."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def __getattr__(self, name: str):
        def record(*args, **kwargs) -> None:
            self.calls.append((name, args, kwargs))

        return record

    def named(self, name: str) -> list[tuple[tuple, dict]]:
        return [(args, kwargs) for n, args, kwargs in self.calls if n == name]

    @property
    def errors(self) -> list[str]:
        return [args[0] for args, _ in self.named("log_error")]

    @property
    def phase_end(self) -> dict:
        ends = self.named("end_phase")
        assert len(ends) == 1, ends
        return ends[0][1]


class _Emitter:
    def __init__(self) -> None:
        self.events: list[tuple[str, dict]] = []

    def emit(self, event_type: str, payload: dict | None = None) -> None:
        self.events.append((event_type, payload or {}))

    @property
    def names(self) -> list[str]:
        return [name for name, _ in self.events]

    def payloads(self, name: str) -> list[dict]:
        return [payload for n, payload in self.events if n == name]


class _Client:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc) -> None:
        return None


def _plan(spec_dir: Path) -> dict:
    return json.loads(
        (spec_dir / "implementation_plan.json").read_text(encoding="utf-8")
    )


def _sign_off(spec_dir: Path, status: str, issues: list[dict]) -> None:
    """What the reviewer writes in the plan before it returns its verdict."""
    plan = _plan(spec_dir)
    signoff = plan.get("qa_signoff") or {}
    plan["qa_signoff"] = {
        "status": status,
        "qa_session": signoff.get("qa_session", 0) + 1,
        "issues_found": issues,
        "tests_passed": {"unit": "12/12"},
    }
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps(plan), encoding="utf-8"
    )


def _issue(title: str) -> dict:
    return {"title": title, "description": f"{title}: details", "type": "critical"}


@pytest.fixture
def harness(tmp_path: Path, monkeypatch):
    """The real loop, with every agent and side channel replaced.

    `reviews` and `fixes` are scripts, one step per session. A review step is
    ("approved" | "rejected" | "human_escalation", issues), ("error", text) or
    an exception to raise; a fix step is "fixed", ("error", text) or an
    exception.
    """
    import qa.loop as loop

    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "0")
    spec_dir = tmp_path / "001-task"
    spec_dir.mkdir()
    (spec_dir / "implementation_plan.json").write_text(
        json.dumps({"feature": "x", "phases": []}), encoding="utf-8"
    )

    state = types.SimpleNamespace(
        spec_dir=spec_dir,
        logger=_Logger(),
        emitter=_Emitter(),
        reviews=[],
        fixes=[],
        review_calls=[],
        fixer_calls=[],
        clients=[],
        client_kwargs=[],
        client_errors={},
        cap=3,
        threshold=10,
    )

    async def reviewer(
        _client, _project_dir, spec, iteration, max_iterations, *_a, **kw
    ):
        state.review_calls.append(
            {
                "iteration": iteration,
                "max": max_iterations,
                "previous_error": kw.get("previous_error"),
                "review_scope": kw.get("review_scope"),
            }
        )
        step = state.reviews.pop(0)
        if isinstance(step, BaseException):
            raise step
        status, payload = step
        if status == "error":
            return "error", payload
        _sign_off(spec, status, payload)
        return status, "ok"

    async def fixer(_client, spec, iteration, _verbose):
        request = spec / "QA_FIX_REQUEST.md"
        state.fixer_calls.append(
            (
                iteration,
                request.read_text(encoding="utf-8") if request.exists() else None,
            )
        )
        step = state.fixes.pop(0) if state.fixes else "fixed"
        if isinstance(step, BaseException):
            raise step
        if isinstance(step, tuple):
            return step
        return step, "ok"

    def create_client(**kwargs):
        agent = kwargs["agent_type"]
        state.clients.append(agent)
        state.client_kwargs.append(kwargs)
        if agent in state.client_errors:
            raise state.client_errors[agent]
        return _Client()

    async def no_security_issue(*_args, **_kwargs):
        return True, None, []

    async def no_jev_advice(*_args, **_kwargs):
        return None

    patches = {
        "is_build_complete": lambda _spec: True,
        "is_no_test_project": lambda *_args: False,
        "run_qa_security_scan": no_security_issue,
        "get_task_logger": lambda _spec: state.logger,
        "emit_phase": lambda *_args, **_kwargs: None,
        "is_linear_enabled": lambda: False,
        "run_visual_qa": lambda *_args: None,
        "write_visual_qa_report": lambda *_args: None,
        "get_phase_model": lambda *_args, **_kwargs: "test-model",
        "get_phase_thinking_budget": lambda *_args, **_kwargs: None,
        "get_phase_provider": lambda *_args, **_kwargs: "anthropic",
        "qa_iteration_cap": lambda _spec: state.cap,
        "recurring_issue_threshold": lambda _cap: state.threshold,
        "create_agent_client": create_client,
        "run_qa_agent_session": reviewer,
        "run_qa_fixer_session": fixer,
    }
    for name, value in patches.items():
        monkeypatch.setattr(loop, name, value)
    monkeypatch.setattr(
        loop.TaskEventEmitter,
        "from_spec_dir",
        staticmethod(lambda _spec: state.emitter),
    )

    import integrations.jev.adapters as jev_adapters
    import integrations.jev.rubrics as jev_rubrics

    monkeypatch.setattr(jev_adapters, "assess_build", no_jev_advice)
    monkeypatch.setattr(jev_rubrics, "advice_text", lambda _outcome: "")

    async def architecture(**_kwargs):
        return True, {"violations": []}

    validator = types.ModuleType("architecture.validator")
    validator.run_architecture_validation = architecture
    validator.write_architecture_fix_request = lambda *_args: None
    package = types.ModuleType("architecture")
    package.validator = validator
    monkeypatch.setitem(sys.modules, "architecture", package)
    monkeypatch.setitem(sys.modules, "architecture.validator", validator)

    async def run() -> bool:
        return await loop.run_qa_validation_loop(
            project_dir=tmp_path, spec_dir=spec_dir, model="test-model"
        )

    state.run = run
    state.loop = loop
    return state


def _history(spec_dir: Path) -> list[tuple[int, str]]:
    return [
        (record["iteration"], record["status"])
        for record in _plan(spec_dir).get("qa_iteration_history", [])
    ]


async def test_an_incomplete_build_is_not_reviewed(harness, monkeypatch):
    monkeypatch.setattr(harness.loop, "is_build_complete", lambda _spec: False)

    assert await harness.run() is False

    assert harness.review_calls == []
    assert harness.emitter.events == []


async def test_an_approved_build_passes_without_a_review(harness):
    _sign_off(harness.spec_dir, "approved", [])

    assert await harness.run() is True

    assert harness.review_calls == []
    assert harness.emitter.events == [
        ("QA_STARTED", {"iteration": 1, "maxIterations": 3}),
        ("QA_PASSED", {"iteration": 0, "testsRun": {}}),
    ]


async def test_a_first_pass_approval_ends_the_loop(harness):
    harness.reviews = [("approved", [])]

    assert await harness.run() is True

    assert [c["iteration"] for c in harness.review_calls] == [1]
    assert harness.fixer_calls == []
    assert harness.emitter.events[-1] == (
        "QA_PASSED",
        {"iteration": 1, "testsRun": {"unit": "12/12"}},
    )
    assert _history(harness.spec_dir) == [(1, "approved")]
    assert harness.logger.phase_end["success"] is True


async def test_a_rejection_runs_the_fixer_on_its_issues(harness):
    harness.reviews = [("rejected", [_issue("Missing null check")]), ("approved", [])]

    assert await harness.run() is True

    assert [iteration for iteration, _ in harness.fixer_calls] == [1]
    assert "Missing null check" in harness.fixer_calls[0][1]
    assert harness.clients == ["qa_reviewer", "qa_fixer", "qa_reviewer"]
    assert _history(harness.spec_dir) == [(1, "rejected"), (2, "approved")]
    assert harness.emitter.payloads("QA_FAILED") == [
        {"iteration": 1, "issueCount": 1, "issues": ["Missing null check"]}
    ]
    assert harness.emitter.names.count("QA_FIXING_STARTED") == 1
    assert harness.emitter.names.count("QA_FIXING_COMPLETE") == 1
    assert harness.logger.errors == [
        "QA pass #1 rejected: 1 issue(s) found; applying a fix, then "
        "re-reviewing (pass #2)."
    ]


async def test_the_last_rejected_pass_hands_over_without_a_fix(harness):
    harness.reviews = [("rejected", [_issue(f"Issue {n}")]) for n in range(3)]

    assert await harness.run() is False

    assert [iteration for iteration, _ in harness.fixer_calls] == [1, 2]
    assert harness.logger.errors[-1] == (
        "QA pass #3 rejected: 1 issue(s) found; handing over to human review."
    )
    assert harness.emitter.payloads("QA_MAX_ITERATIONS") == [
        {"iteration": 3, "maxIterations": 3}
    ]
    assert _history(harness.spec_dir) == [
        (1, "rejected"),
        (2, "rejected"),
        (3, "rejected"),
    ]
    assert harness.logger.phase_end == {
        "success": False,
        "message": "QA validation incomplete after 3 iterations",
    }


async def test_a_recurring_issue_escalates_to_a_human(harness):
    harness.cap = 5
    harness.threshold = 2
    harness.reviews = [("rejected", [_issue("Same flaw")])] * 2

    assert await harness.run() is False

    assert [iteration for iteration, _ in harness.fixer_calls] == [1]
    assert harness.logger.errors[-1] == (
        "QA pass #2 rejected: 1 issue(s) found; handing over to human review."
    )
    assert (harness.spec_dir / "QA_ESCALATION.md").exists()
    assert harness.emitter.payloads("QA_MAX_ITERATIONS") == [
        {"iteration": 2, "maxIterations": 5}
    ]
    assert harness.logger.phase_end == {
        "success": False,
        "message": "QA escalated to human after 2 iterations due to recurring issues",
    }


async def test_a_human_escalation_verdict_passes_for_manual_checks(harness):
    harness.reviews = [("human_escalation", [])]

    assert await harness.run() is True

    assert harness.fixer_calls == []
    assert harness.emitter.events[-1] == (
        "QA_PASSED",
        {
            "iteration": 1,
            "testsRun": {"unit": "12/12"},
            "manualVerificationRequired": True,
        },
    )
    assert harness.logger.phase_end["success"] is True


async def test_a_reviewer_error_is_fed_back_to_the_next_pass(harness):
    harness.reviews = [("error", "no qa_signoff written"), ("approved", [])]

    assert await harness.run() is True

    assert harness.review_calls[0]["previous_error"] is None
    feedback = harness.review_calls[1]["previous_error"]
    assert feedback["error_message"] == "no qa_signoff written"
    assert feedback["consecutive_errors"] == 1
    assert _history(harness.spec_dir) == [(1, "error"), (2, "approved")]


async def test_three_reviewer_errors_in_a_row_stop_the_loop(harness):
    harness.cap = 5
    harness.reviews = [("error", f"failure {n}") for n in range(3)]

    assert await harness.run() is False

    assert [c["iteration"] for c in harness.review_calls] == [1, 2, 3]
    assert [
        c["previous_error"] and c["previous_error"]["consecutive_errors"]
        for c in harness.review_calls
    ] == [None, 1, 2]
    assert harness.emitter.payloads("QA_AGENT_ERROR") == [
        {"iteration": 3, "consecutiveErrors": 3, "error": "failure 2"}
    ]
    assert harness.logger.phase_end["success"] is False
    assert harness.logger.phase_end["message"].startswith(
        "QA agent failed 3 consecutive times"
    )


async def test_a_rejection_resets_the_error_count(harness):
    harness.cap = 6
    harness.reviews = [
        ("error", "a"),
        ("error", "b"),
        ("rejected", [_issue("Real flaw")]),
        ("error", "c"),
        ("approved", []),
    ]

    assert await harness.run() is True

    assert [
        c["previous_error"] and c["previous_error"]["consecutive_errors"]
        for c in harness.review_calls
    ] == [None, 1, 2, None, 1]


async def test_a_crashed_reviewer_session_counts_as_an_error(harness):
    harness.reviews = [RuntimeError("socket closed"), ("approved", [])]

    assert await harness.run() is True

    assert harness.review_calls[1]["previous_error"]["error_message"] == (
        "socket closed"
    )
    assert _history(harness.spec_dir) == [(1, "error"), (2, "approved")]


async def test_a_rate_limited_pass_is_retried_on_the_same_iteration(
    harness, monkeypatch
):
    limited: list[str] = []

    async def shield(error, _spec, _source):
        limited.append(str(error))
        return True

    monkeypatch.setattr(harness.loop, "_handle_rate_limit_in_qa", shield)
    harness.reviews = [RuntimeError("429 rate limited"), ("approved", [])]

    assert await harness.run() is True

    assert limited == ["429 rate limited"]
    assert [c["iteration"] for c in harness.review_calls] == [1, 1]
    assert _history(harness.spec_dir) == [(1, "approved")]


async def test_a_prompt_too_long_reviewer_halts(harness, monkeypatch):
    import services.rate_limit_shield as shield

    monkeypatch.setattr(shield, "handle_prompt_too_long", lambda *_args: True)
    harness.reviews = [RuntimeError("prompt is too long")]

    assert await harness.run() is False

    assert len(harness.review_calls) == 1
    assert harness.logger.phase_end == {
        "success": False,
        "message": "QA halted: prompt too long for the LLM context window",
    }


async def test_a_reviewer_client_that_cannot_be_built_stops(harness):
    harness.client_errors["qa_reviewer"] = RuntimeError("no credentials")

    assert await harness.run() is False

    assert harness.review_calls == []
    assert harness.emitter.payloads("QA_AGENT_ERROR") == [
        {"iteration": 1, "consecutiveErrors": 1, "error": "no credentials"}
    ]


async def test_a_fixer_error_ends_the_loop(harness):
    harness.reviews = [("rejected", [_issue("Broken")])]
    harness.fixes = [("error", "fixer gave up")]

    assert await harness.run() is False

    assert len(harness.review_calls) == 1
    assert _history(harness.spec_dir) == [(1, "rejected"), (1, "error")]
    assert harness.emitter.payloads("QA_MAX_ITERATIONS") == [
        {"iteration": 1, "maxIterations": 3}
    ]


async def test_a_fixer_client_that_cannot_be_built_ends_the_loop(harness):
    harness.reviews = [("rejected", [_issue("Broken")])]
    harness.client_errors["qa_fixer"] = RuntimeError("no credentials")

    assert await harness.run() is False

    assert harness.fixer_calls == []
    assert _history(harness.spec_dir) == [(1, "rejected"), (1, "error")]


async def test_a_rate_limited_fix_reruns_the_pass(harness, monkeypatch):
    async def shield(*_args):
        return True

    monkeypatch.setattr(harness.loop, "_handle_rate_limit_in_qa", shield)
    harness.reviews = [("rejected", [_issue("Broken")]), ("approved", [])]
    harness.fixes = [RuntimeError("429 rate limited")]

    assert await harness.run() is True

    assert [c["iteration"] for c in harness.review_calls] == [1, 1]
    assert [iteration for iteration, _ in harness.fixer_calls] == [1]


async def test_human_feedback_runs_the_fixer_first(harness):
    _sign_off(harness.spec_dir, "approved", [])
    (harness.spec_dir / "QA_FIX_REQUEST.md").write_text(
        "# Human feedback\nRename the button", encoding="utf-8"
    )
    harness.reviews = [("approved", [])]

    assert await harness.run() is True

    assert harness.fixer_calls == [(0, "# Human feedback\nRename the button")]
    assert harness.clients == ["qa_fixer", "qa_reviewer"]
    assert not (harness.spec_dir / "QA_FIX_REQUEST.md").exists()
    assert harness.emitter.names[:3] == [
        "QA_STARTED",
        "QA_FIXING_STARTED",
        "QA_FIXING_COMPLETE",
    ]


async def test_human_feedback_opens_a_new_budget(harness):
    # Three passes already spent: the reviewer's sign-off counts them.
    for _ in range(3):
        _sign_off(harness.spec_dir, "rejected", [_issue("Old flaw")])
    (harness.spec_dir / "QA_FIX_REQUEST.md").write_text("# More", encoding="utf-8")
    harness.reviews = [("approved", [])]

    assert await harness.run() is True

    assert harness.review_calls[0]["iteration"] == 4
    assert harness.review_calls[0]["max"] == 6


async def test_a_failed_human_feedback_fix_stops(harness):
    (harness.spec_dir / "QA_FIX_REQUEST.md").write_text("# Fix", encoding="utf-8")
    harness.fixes = [("error", "could not apply")]

    assert await harness.run() is False

    assert harness.review_calls == []
    assert (harness.spec_dir / "QA_FIX_REQUEST.md").exists()


async def test_a_pause_between_passes_raises(harness, monkeypatch):
    monkeypatch.setattr(harness.loop, "is_paused", lambda _spec: True)
    monkeypatch.setattr(
        harness.loop,
        "read_pause_state",
        lambda _spec: {"paused_phase": "qa_review", "paused_at": "now"},
    )

    with pytest.raises(BuildPaused):
        await harness.run()

    assert harness.review_calls == []


def _git(cwd: Path, *args: str) -> None:
    import subprocess

    subprocess.run(
        ["git", "-c", "user.email=qa@test", "-c", "user.name=qa", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
    )


def _task_branch(project: Path, files: dict[str, str]) -> None:
    """A `main` with one commit, and a task branch that adds `files`."""
    _git(project, "init", "-q", "-b", "main")
    # The spec directory lives in the project in this harness; in a real
    # worktree it is under the gitignored `.workpilot/`.
    (project / ".gitignore").write_text("001-task/\n", encoding="utf-8")
    _git(project, "add", ".gitignore")
    _git(project, "commit", "-q", "-m", "init")
    _git(project, "checkout", "-q", "-b", "task")
    for name, content in files.items():
        (project / name).write_text(content, encoding="utf-8")
    _git(project, "add", *files)
    _git(project, "commit", "-q", "-m", "task")


async def test_a_text_only_task_is_not_rejected_by_the_coverage_gate(
    harness, monkeypatch
):
    """Leub, 2026-10-31: "Create toto.txt" gave up after 3 passes.

    The reviewer approved, but a text file has no coverage to measure, the
    gate at 100 % turned every approval into a rejection, and the fixer
    could not add coverage to a `.txt`.
    """
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "100")
    _task_branch(harness.spec_dir.parent, {"toto.txt": "OK\n"})
    harness.reviews = [("approved", [])]

    assert await harness.run() is True

    assert len(harness.review_calls) == 1
    scope = harness.review_calls[0]["review_scope"]
    assert scope.is_light and scope.files == ("toto.txt",)
    # No test-runner roster for a change nothing executes.
    assert harness.client_kwargs[0]["use_subagents"] is False


async def test_a_code_change_still_meets_the_coverage_gate(harness, monkeypatch):
    monkeypatch.setenv("WORKPILOT_QA_MIN_COVERAGE", "100")
    _task_branch(harness.spec_dir.parent, {"toto.py": "print('OK')\n"})
    harness.cap = 1
    harness.reviews = [("approved", [])]

    assert await harness.run() is False

    scope = harness.review_calls[0]["review_scope"]
    assert not scope.is_light
    assert harness.client_kwargs[0]["use_subagents"] is True
