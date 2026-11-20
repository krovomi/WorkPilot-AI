"""runners/github/runner.py: the commands that call a model, with a stand-in orchestrator.

The model runs inside `GitHubOrchestrator`; what the runner owns is reading
the arguments, handing them over, printing the outcome the desktop app shows
and choosing the exit code. A stand-in orchestrator records each call and
returns real result objects (`PRReviewResult`, `TriageResult`, `IssueBatch`).
The configuration still goes through `get_config` and a fake `gh`.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import sys
from pathlib import Path

import pytest

from tests.gh_fake import write_fake_gh

RUNNER = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "backend"
    / "runners"
    / "github"
    / "runner.py"
)


_RUNNER_PACKAGES = ("runners", "runners.github", "runners.github.services")


@pytest.fixture(scope="module")
def runner():
    # The runner puts its own folders first on sys.path; the rest of the
    # session must not inherit that order.
    saved = list(sys.path)
    # A test module collected earlier may have left bare stand-ins for these
    # packages (no spec, only a __path__), which the runner's imports would
    # resolve against. Import the real ones, then put the stand-ins back for
    # the tests that rely on them.
    stand_ins = {
        name: sys.modules.pop(name)
        for name in _RUNNER_PACKAGES
        if name in sys.modules and getattr(sys.modules[name], "__spec__", None) is None
    }
    spec = importlib.util.spec_from_file_location("github_runner_cli", RUNNER)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = saved
        sys.modules.update(stand_ins)
    return module


@pytest.fixture(scope="module")
def models(runner):
    return sys.modules["models"]


@pytest.fixture
def batches(runner):
    # Imported lazily by the batch processor, by bare name from the runner.
    return importlib.import_module("batch_issues")


@pytest.fixture(autouse=True)
def fake_gh(tmp_path, monkeypatch):
    gh = write_fake_gh(
        tmp_path / "gh", {"--version": {"stdout": "gh version 2.80.0\n"}}
    )
    monkeypatch.setenv("GITHUB_CLI_PATH", str(gh.path))
    for var in ("GITHUB_TOKEN", "GITHUB_BOT_TOKEN", "GITHUB_REPO", "DEBUG"):
        monkeypatch.delenv(var, raising=False)
    import core.gh_executable as gh_executable

    monkeypatch.setattr(gh_executable, "_cached_gh_path", None)
    return gh


class StandIn:
    """Records what the runner asks and answers with the outcome a test chose."""

    answers: dict[str, object] = {}
    calls: list[tuple[str, tuple, dict]] = []
    created: list[dict] = []

    def __init__(self, **kwargs):
        StandIn.created.append(kwargs)

    def __getattr__(self, name):
        async def call(*args, **kwargs):
            StandIn.calls.append((name, args, kwargs))
            answer = StandIn.answers[name]
            if isinstance(answer, BaseException):
                raise answer
            return answer

        return call


@pytest.fixture
def orchestrator(runner, monkeypatch):
    StandIn.answers, StandIn.calls, StandIn.created = {}, [], []
    monkeypatch.setattr(runner, "GitHubOrchestrator", StandIn)
    return StandIn


def _args(tmp_path: Path, **extra) -> argparse.Namespace:
    base = {
        "project": tmp_path,
        "token": "t0k",
        "bot_token": None,
        "repo": "own/repo",
        "model": "some-model",
        "thinking_level": "medium",
    }
    return argparse.Namespace(**{**base, **extra})


def _finding(models, severity: str, title: str):
    return models.PRReviewFinding(
        id=title,
        severity=models.ReviewSeverity(severity),
        category=models.ReviewCategory("security"),
        title=title,
        description="d",
        file="app.py",
        line=7,
    )


def test_review_pr_prints_each_finding_and_passes_force(
    runner, models, orchestrator, tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("DEBUG", "1")
    orchestrator.answers["review_pr"] = models.PRReviewResult(
        pr_number=12,
        repo="own/repo",
        success=True,
        findings=[
            _finding(models, "critical", "SQL built by hand"),
            _finding(models, "low", "Name"),
        ],
        summary="Two things",
        overall_status="request_changes",
    )
    code = asyncio.run(runner.cmd_review_pr(_args(tmp_path, pr_number=12, force=True)))
    out = capsys.readouterr().out
    assert code == 0
    assert orchestrator.calls == [("review_pr", (12,), {"force_review": True})]
    assert orchestrator.created[0]["config"].repo == "own/repo"
    assert "PR #12 Review Complete" in out
    assert "Status: request_changes" in out
    assert "! [CRITICAL] SQL built by hand" in out
    assert ". [LOW] Name" in out
    assert "File: app.py:7" in out
    assert "[DEBUG] review_pr returned, success=True" in out


def test_review_pr_reports_a_failed_review(
    runner, models, orchestrator, tmp_path, capsys
):
    orchestrator.answers["review_pr"] = models.PRReviewResult(
        pr_number=3, repo="own/repo", success=False, error="rate limited"
    )
    assert asyncio.run(runner.cmd_review_pr(_args(tmp_path, pr_number=3))) == 1
    assert "Review failed: rate limited" in capsys.readouterr().out


def test_followup_review_prints_what_changed(
    runner, models, orchestrator, tmp_path, capsys, monkeypatch
):
    monkeypatch.setenv("DEBUG", "1")
    result = models.PRReviewResult(
        pr_number=9,
        repo="own/repo",
        success=True,
        findings=[_finding(models, "high", "Still unchecked")],
        summary="Better",
        overall_status="comment",
    )
    result.is_followup_review = True
    result.resolved_findings = ["a", "b"]
    result.unresolved_findings = ["c"]
    result.new_findings_since_last_review = ["d"]
    orchestrator.answers["followup_review_pr"] = result
    assert asyncio.run(runner.cmd_followup_review_pr(_args(tmp_path, pr_number=9))) == 0
    out = capsys.readouterr().out
    assert "PR #9 Follow-up Review Complete" in out
    assert "Resolved: 2 finding(s)" in out
    assert "Still Open: 1 finding(s)" in out
    assert "New Issues: 1 finding(s)" in out
    assert "* [HIGH] Still unchecked" in out


def test_followup_review_without_a_first_review_fails(
    runner, models, orchestrator, tmp_path, capsys
):
    orchestrator.answers["followup_review_pr"] = ValueError(
        "no previous review of PR #9"
    )
    assert asyncio.run(runner.cmd_followup_review_pr(_args(tmp_path, pr_number=9))) == 1
    assert (
        "Follow-up review failed: no previous review of PR #9"
        in capsys.readouterr().out
    )

    orchestrator.answers["followup_review_pr"] = models.PRReviewResult(
        pr_number=9, repo="own/repo", success=False, error="boom"
    )
    assert asyncio.run(runner.cmd_followup_review_pr(_args(tmp_path, pr_number=9))) == 1
    assert "Follow-up review failed: boom" in capsys.readouterr().out


def test_triage_prints_flags_and_labels(runner, models, orchestrator, tmp_path, capsys):
    category = models.TriageCategory
    orchestrator.answers["triage_issues"] = [
        models.TriageResult(
            issue_number=4,
            repo="own/repo",
            category=category.DUPLICATE,
            confidence=0.9,
            is_duplicate=True,
            duplicate_of=2,
            is_spam=True,
            is_feature_creep=True,
            labels_to_add=["duplicate", "triage"],
        ),
        models.TriageResult(
            issue_number=5, repo="own/repo", category=category.BUG, confidence=0.5
        ),
    ]
    assert (
        asyncio.run(
            runner.cmd_triage(_args(tmp_path, issues=[4, 5], apply_labels=True))
        )
        == 0
    )
    out = capsys.readouterr().out
    assert orchestrator.calls == [
        ("triage_issues", (), {"issue_numbers": [4, 5], "apply_labels": True})
    ]
    assert "Triaged 2 issues" in out
    assert "#4: duplicate (confidence: 90%) [DUP of #2, SPAM, CREEP]" in out
    assert "+ Labels: duplicate, triage" in out
    assert "#5: bug (confidence: 50%)\n" in out


def test_triage_without_numbers_takes_every_open_issue(
    runner, orchestrator, tmp_path, capsys
):
    orchestrator.answers["triage_issues"] = []
    asyncio.run(runner.cmd_triage(_args(tmp_path, issues=[], apply_labels=False)))
    assert orchestrator.calls[0][2]["issue_numbers"] is None


def test_auto_fix_turns_auto_fix_on_and_prints_the_state(
    runner, models, orchestrator, tmp_path, capsys
):
    state = models.AutoFixState(issue_number=8, issue_url="u", repo="own/repo")
    state.status = models.AutoFixStatus.FAILED
    state.spec_id, state.pr_number, state.error = "008-fix", 31, "QA rejected"
    orchestrator.answers["auto_fix_issue"] = state
    assert asyncio.run(runner.cmd_auto_fix(_args(tmp_path, issue_number=8))) == 0
    out = capsys.readouterr().out
    assert orchestrator.created[0]["config"].auto_fix_enabled is True
    assert "Auto-Fix State for Issue #8" in out
    for line in ("Status: failed", "Spec ID: 008-fix", "PR: #31", "Error: QA rejected"):
        assert line in out


def _batch(batches, models, spec_id=None):
    return batches.IssueBatch(
        batch_id="b-1",
        repo="own/repo",
        primary_issue=1,
        issues=[
            batches.IssueBatchItem(issue_number=1, title="A", body=""),
            batches.IssueBatchItem(issue_number=2, title="B", body=""),
        ],
        spec_id=spec_id,
        theme="Login",
    )


def test_batch_issues_lists_each_batch(
    runner, models, batches, orchestrator, tmp_path, capsys
):
    orchestrator.answers["batch_and_fix_issues"] = [
        _batch(batches, models, spec_id="010-login")
    ]
    assert asyncio.run(runner.cmd_batch_issues(_args(tmp_path, issues=[1, 2]))) == 0
    out = capsys.readouterr().out
    assert orchestrator.calls == [("batch_and_fix_issues", ([1, 2],), {})]
    assert "Created 1 batches from similar issues" in out
    assert "Issues: #1, #2" in out
    assert "Theme: Login" in out
    assert "Spec: 010-login" in out


def test_batch_issues_with_nothing_to_group(runner, orchestrator, tmp_path, capsys):
    orchestrator.answers["batch_and_fix_issues"] = []
    assert asyncio.run(runner.cmd_batch_issues(_args(tmp_path, issues=[]))) == 0
    assert orchestrator.calls[0][1] == (None,)
    assert "No batches created." in capsys.readouterr().out


PREVIEW = {
    "success": True,
    "total_issues": 3,
    "analyzed_issues": 3,
    "already_batched": 0,
    "proposed_batches": [
        {
            "theme": "Login",
            "confidence": 0.8,
            "validated": False,
            "primary_issue": 1,
            "issue_count": 2,
            "reasoning": "same stack trace",
            "issues": [
                {"issue_number": 1, "title": "A", "similarity_to_primary": 1.0},
                {"issue_number": 2, "similarity_to_primary": 0.75},
            ],
        }
    ],
    "single_issues": [3],
}


def test_analyze_preview_prints_the_batches_for_review_and_the_json(
    runner, orchestrator, tmp_path, capsys
):
    orchestrator.answers["analyze_issues_preview"] = PREVIEW
    args = _args(tmp_path, issues=[], max_issues=50, json=True)
    assert asyncio.run(runner.cmd_analyze_preview(args)) == 0
    out = capsys.readouterr().out
    assert orchestrator.calls == [
        ("analyze_issues_preview", (), {"issue_numbers": None, "max_issues": 50})
    ]
    assert "Proposed batches: 1" in out
    assert "Batch 1: [NEEDS REVIEW] Login (80% confidence)" in out
    assert "- #1: A (100%)" in out
    assert "- #2: ? (75%)" in out
    assert json.loads(out.rsplit("=" * 60, 1)[1]) == PREVIEW


def test_analyze_preview_reports_a_failure(runner, orchestrator, tmp_path, capsys):
    orchestrator.answers["analyze_issues_preview"] = {"success": False}
    assert asyncio.run(runner.cmd_analyze_preview(_args(tmp_path, issues=[4]))) == 1
    assert "Error: Unknown error" in capsys.readouterr().out


def test_approve_batches_hands_the_file_over(
    runner, models, batches, orchestrator, tmp_path, capsys
):
    approved = tmp_path / "approved.json"
    approved.write_text(json.dumps(PREVIEW["proposed_batches"]), encoding="utf-8")
    orchestrator.answers["approve_and_execute_batches"] = [_batch(batches, models)]
    assert (
        asyncio.run(runner.cmd_approve_batches(_args(tmp_path, batch_file=approved)))
        == 0
    )
    out = capsys.readouterr().out
    assert orchestrator.calls == [
        ("approve_and_execute_batches", (PREVIEW["proposed_batches"],), {})
    ]
    assert "Approving and executing 1 batches..." in out
    assert "b-1: #1, #2" in out


def test_progress_names_the_pr_or_the_issue(runner, monkeypatch):
    callback = sys.modules["orchestrator"].ProgressCallback
    lines = []
    monkeypatch.setattr(runner, "safe_print", lines.append)
    runner.print_progress(
        callback(phase="p", progress=5, message="fetching", pr_number=3)
    )
    runner.print_progress(
        callback(phase="p", progress=50, message="labelling", issue_number=8)
    )
    runner.print_progress(callback(phase="p", progress=100, message="done"))
    assert lines == [
        "[PR #3] [  5%] fetching",
        "[Issue #8] [ 50%] labelling",
        "[100%] done",
    ]


def test_an_interrupt_ends_the_run_with_a_failure(
    runner, monkeypatch, capsys, tmp_path
):
    async def interrupted(_args):
        raise KeyboardInterrupt

    monkeypatch.setattr(runner, "cmd_queue", interrupted)
    monkeypatch.setattr(sys, "argv", ["runner.py", "--project", str(tmp_path), "queue"])
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    assert "Interrupted." in capsys.readouterr().out


def test_a_gh_that_vanished_is_the_same_as_no_gh(runner, monkeypatch, tmp_path, capsys):
    import core.gh_executable as gh_executable

    monkeypatch.setattr(
        gh_executable, "get_gh_executable", lambda: str(tmp_path / "gone" / "gh")
    )
    with pytest.raises(SystemExit) as stop:
        runner.get_config(_args(tmp_path, token=None, repo=None))
    assert stop.value.code == 1
    assert "Error: No GitHub token found" in capsys.readouterr().out
