"""Following up on a reviewed pull request.

After a first review, the app's "follow-up" button asks
`GitHubOrchestrator.followup_review_pr` to look only at what changed: the
commits (or, after a rebase, the files) since the reviewed commit, and the CI.
With nothing new, the saved verdict is refreshed from the CI alone; with new
changes, a follow-up reviewer runs and failing CI still blocks the merge.

What stands in: `gh` (tests/gh_fake.py), the follow-up context gatherer and
the two follow-up reviewers (another suite covers them; here they hand over
real `FollowupReviewContext` and `PRReviewResult` objects). The saved
reviews, the bot detector's state and the CI reads are real.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from runners.github.models import (
    FollowupReviewContext,
    MergeVerdict,
    PRReviewFinding,
    PRReviewResult,
    ReviewCategory,
    ReviewSeverity,
)

OLD = "aaa111bbb222"
NEW = "ccc333ddd444"
CHECKS = "pr checks 5 --json name,state -R own/repo"
HEAD_OID = "pr view 5 --json headRefOid -R own/repo"
RUNS = "api --method GET repos/{owner}/{repo}/actions/runs?status=action_required&per_page=100"


def finding(fid, severity=ReviewSeverity.MEDIUM) -> PRReviewFinding:
    return PRReviewFinding(
        id=fid,
        severity=severity,
        category=ReviewCategory.QUALITY,
        title="t",
        description="d",
        file="a.py",
        line=1,
    )


def checks(*states) -> dict:
    return {"stdout": json.dumps([{"name": name, "state": st} for name, st in states])}


def awaiting(count: int) -> dict:
    runs = [{"id": i, "name": "CI", "head_sha": NEW} for i in range(count)]
    return {
        HEAD_OID: {"stdout": json.dumps({"headRefOid": NEW})},
        RUNS: {"stdout": json.dumps({"workflow_runs": runs})},
    }


class _Reviewer:
    """Both follow-up reviewers' seam: built with a progress callback, then
    `review_followup(context)` (sequential) or `review(context)` (parallel)."""

    def __init__(self, state, progress_events, **built):
        self.state = state
        self.progress_events = progress_events
        state.reviewers.append(built)

    async def _run(self, followup_context):
        self.state.reviewed.append(followup_context)
        for event in self.progress_events:
            self.state.reviewers[-1]["progress_callback"](event)
        if self.state.reviewer_error:
            raise self.state.reviewer_error
        return self.state.result()

    review_followup = _run
    review = _run


@pytest.fixture
def followup(orchestrator, gh, monkeypatch):
    """PR #5, reviewed at OLD, and a follow-up of it."""
    gatherers = importlib.import_module("runners.github.context_gatherer")
    sequential = importlib.import_module("runners.github.services.followup_reviewer")
    state = SimpleNamespace(
        gh=gh,
        github_dir=orchestrator.project / ".workpilot" / "github",
        progress=orchestrator.progress,
        hermes=orchestrator.hermes,
        gathered=[],
        reviewers=[],
        reviewed=[],
        reviewer_error=None,
        context=None,
        result=lambda: PRReviewResult(
            pr_number=5,
            repo="own/repo",
            success=True,
            summary="Looks better now.",
            verdict=MergeVerdict.READY_TO_MERGE,
            overall_status="approve",
            reviewed_commit_sha=NEW,
            is_followup_review=True,
        ),
    )

    class Gatherer:
        def __init__(self, project_dir, pr_number, previous_review, repo=None):
            state.gathered.append((Path(project_dir), pr_number, repo))
            self.previous_review = previous_review

        async def gather(self):
            values = {
                "pr_number": 5,
                "previous_review": self.previous_review,
                "previous_commit_sha": OLD,
                "current_commit_sha": NEW,
            }
            values.update(state.context or {})
            return FollowupReviewContext(**values)

    monkeypatch.setattr(gatherers, "FollowupContextGatherer", Gatherer)
    monkeypatch.setattr(
        sequential,
        "FollowupReviewer",
        lambda **built: _Reviewer(state, [{"phase": "analyzing"}, {}], **built),
    )
    # The parallel reviewer's module only imports under the runner's own flat
    # layout (tests/test_review_feedback_wiring.py preloads its neighbours);
    # its seam here is the module itself.
    parallel = ModuleType("runners.github.services.parallel_followup_reviewer")
    parallel.ParallelFollowupReviewer = lambda **built: _Reviewer(
        state,
        [
            SimpleNamespace(phase="orchestrating", progress=40, message="Specialists"),
            {},
        ],
        **built,
    )
    monkeypatch.setitem(sys.modules, parallel.__name__, parallel)

    def previous(**fields):
        values = {
            "pr_number": 5,
            "repo": "own/repo",
            "success": True,
            "summary": "First review",
            "reviewed_commit_sha": OLD,
        }
        values.update(fields)
        asyncio.run(PRReviewResult(**values).save(state.github_dir))

    def run(**config):
        orch = orchestrator(**config)
        return asyncio.run(orch.followup_review_pr(5))

    def in_progress():
        path = state.github_dir / "bot_detection_state.json"
        return json.loads(path.read_text(encoding="utf-8"))["in_progress_reviews"]

    state.previous, state.run, state.in_progress = previous, run, in_progress
    gh.answer({})
    return state


# ---------------------------------------------------------------------------
# What a follow-up needs first
# ---------------------------------------------------------------------------


def test_a_follow_up_needs_a_first_review(followup):
    with pytest.raises(ValueError, match="No previous review found for PR #5"):
        followup.run()


def test_a_follow_up_needs_the_commit_the_first_review_saw(followup):
    followup.previous(reviewed_commit_sha=None)

    with pytest.raises(ValueError, match="doesn't have commit SHA"):
        followup.run()


def test_the_follow_up_reads_the_configured_repository(followup, orchestrator):
    followup.previous()

    followup.run()

    assert followup.gathered == [(orchestrator.project, 5, "own/repo")]


def test_a_follow_up_whose_context_fails_is_saved_as_failed(followup):
    followup.previous()
    followup.context = {"error": "PR not found", "current_commit_sha": ""}

    result = followup.run()

    assert not result.success and result.is_followup_review
    assert result.error == "PR not found"
    assert result.verdict is MergeVerdict.NEEDS_REVISION
    assert result.summary == "Follow-up review failed: PR not found"
    assert result.reviewed_commit_sha == OLD
    assert PRReviewResult.load(followup.github_dir, 5).error == "PR not found"
    # The PR is free for the next review.
    assert followup.in_progress() == {}


# ---------------------------------------------------------------------------
# Nothing new since the review: the verdict follows the CI
# ---------------------------------------------------------------------------


def test_with_no_new_commits_the_previous_verdict_and_findings_stand(followup):
    followup.previous(
        verdict=MergeVerdict.MERGE_WITH_CHANGES,
        findings=[finding("f1")],
        blockers=["Structure: God object"],
    )

    result = followup.run()

    assert result.success and result.is_followup_review
    assert result.verdict is MergeVerdict.MERGE_WITH_CHANGES
    assert result.overall_status == "comment"
    assert result.verdict_reasoning == "No changes since last review."
    assert result.summary == (
        "No new commits since last review. Previous findings still apply."
    )
    assert result.unresolved_findings == ["f1"]
    assert result.blockers == ["Structure: God object"]
    assert result.reviewed_commit_sha == NEW
    assert followup.reviewed == []
    assert followup.in_progress() == {}
    assert PRReviewResult.load(followup.github_dir, 5).is_followup_review


def test_with_no_new_commits_failing_ci_keeps_the_pr_blocked(followup):
    followup.previous(
        verdict=MergeVerdict.BLOCKED,
        blockers=["CI Failed: old-check", "Workflows Pending: 1 workflow(s)", "Other"],
    )
    followup.context = {"current_commit_sha": ""}
    # Two checks of the same name (two workflows): listed once.
    followup.gh.answer(
        {CHECKS: checks(("lint", "FAILURE"), ("lint", "FAILURE"), ("unit", "SUCCESS"))}
    )

    result = followup.run()

    assert result.verdict is MergeVerdict.BLOCKED
    assert result.overall_status == "request_changes"
    assert result.verdict_reasoning == (
        "No code changes since last review. 2 CI check(s) still failing."
    )
    assert result.summary == (
        "No new commits since last review. CI status: 2 check(s) failing. "
        "Failing: lint, lint"
    )
    assert result.blockers == ["Other", "CI Failed: lint"]
    assert result.reviewed_commit_sha == OLD


def test_with_no_new_commits_fork_workflows_awaiting_approval_keep_it_blocked(
    followup,
):
    followup.previous(verdict=MergeVerdict.READY_TO_MERGE)
    followup.gh.answer(awaiting(2))

    result = followup.run()

    assert result.verdict is MergeVerdict.BLOCKED
    assert result.verdict_reasoning == (
        "No code changes since last review. 2 workflow(s) awaiting approval."
    )
    assert "2 workflow(s) awaiting maintainer approval" in result.summary
    assert result.blockers == [
        "Workflows Pending: 2 workflow(s) awaiting maintainer approval"
    ]


CI_BLOCKED = ["CI Failed: lint"]

RECOVERED = {
    "other blockers remain": (
        {"blockers": CI_BLOCKED + ["Structure: A", "Structure: B"]},
        MergeVerdict.BLOCKED,
        "CI checks now passing. Non-CI blockers still remain: Structure: A, Structure: B",
    ),
    "findings need attention": (
        {
            "blockers": CI_BLOCKED,
            "findings": [finding("m"), finding("l", ReviewSeverity.LOW)],
        },
        MergeVerdict.NEEDS_REVISION,
        "CI checks now passing. 1 code finding(s) still require attention.",
    ),
    "only suggestions left": (
        {"blockers": CI_BLOCKED, "findings": [finding("l", ReviewSeverity.LOW)]},
        MergeVerdict.READY_TO_MERGE,
        "CI checks now passing. 1 non-blocking suggestion(s) to consider.",
    ),
    "nothing left": (
        {"blockers": ["Workflows Pending: 1 workflow(s)"]},
        MergeVerdict.READY_TO_MERGE,
        "CI checks now passing. No outstanding code issues.",
    ),
}


@pytest.mark.parametrize("case", list(RECOVERED), ids=list(RECOVERED))
def test_when_ci_recovers_the_verdict_is_lifted_as_far_as_the_code_allows(
    followup, case
):
    previous, verdict, reasoning = RECOVERED[case]
    followup.previous(verdict=MergeVerdict.BLOCKED, **previous)
    followup.gh.answer({CHECKS: checks(("lint", "SUCCESS"))})

    result = followup.run()

    assert result.verdict is verdict
    assert result.verdict_reasoning == reasoning
    assert result.summary == (
        "No new commits since last review. "
        "CI checks are now passing. Previous findings still apply."
    )
    assert not any(b.startswith(("CI Failed:", "Workflows")) for b in result.blockers)


# ---------------------------------------------------------------------------
# New changes: a follow-up reviewer runs
# ---------------------------------------------------------------------------


def test_new_commits_are_reviewed_by_the_sequential_reviewer_when_chosen(
    followup, orchestrator
):
    followup.previous()
    followup.context = {"commits_since_review": [{"oid": NEW}, {"oid": "x"}]}

    result = followup.run(use_parallel_orchestrator=False)

    assert result.summary == "Looks better now."
    assert result.verdict is MergeVerdict.READY_TO_MERGE
    assert isinstance(result.jev, dict)
    built = followup.reviewers[0]
    assert built["project_dir"] == orchestrator.project
    assert built["config"].repo == "own/repo"
    assert followup.reviewed[0].ci_status["failing"] == 0
    assert PRReviewResult.load(followup.github_dir, 5).summary == "Looks better now."
    state = json.loads(
        (followup.github_dir / "bot_detection_state.json").read_text(encoding="utf-8")
    )
    assert state["reviewed_commits"] == {"5": [NEW]}
    assert state["in_progress_reviews"] == {}
    assert followup.hermes == [True]
    # The reviewer's own progress reaches the app, with defaults filled in.
    events = [(p.phase, p.progress, p.message) for p in followup.progress]
    assert events == [
        ("gathering_context", 10, "Gathering follow-up context for PR #5..."),
        ("analyzing", 30, "Analyzing 2 new commits..."),
        ("analyzing", 50, "Reviewing..."),
        ("analyzing", 50, "Reviewing..."),
        ("complete", 100, "Follow-up review complete!"),
    ]


def test_after_a_rebase_the_changed_files_are_reviewed(followup):
    followup.previous()
    followup.context = {"files_changed_since_review": ["a.py", "b.py"]}

    followup.run()

    assert ("analyzing", 30, "Analyzing 2 files (rebase detected)...") in [
        (p.phase, p.progress, p.message) for p in followup.progress
    ]


def test_the_parallel_reviewer_runs_by_default(followup):
    followup.previous()
    followup.context = {"commits_since_review": [{"oid": NEW}]}

    result = followup.run()

    assert result.summary == "Looks better now." and isinstance(result.jev, dict)
    assert ("orchestrating", 40, "Specialists") in [
        (p.phase, p.progress, p.message) for p in followup.progress
    ]
    assert ("analyzing", 50, "Reviewing...") in [
        (p.phase, p.progress, p.message) for p in followup.progress
    ]


def test_failing_ci_blocks_a_follow_up_that_would_have_approved(followup):
    followup.previous()
    followup.context = {"commits_since_review": [{"oid": NEW}]}
    followup.gh.answer({CHECKS: checks(("lint", "FAILURE"), ("unit", "TIMED_OUT"))})

    result = followup.run()

    assert result.verdict is MergeVerdict.BLOCKED
    assert result.overall_status == "request_changes"
    assert result.verdict_reasoning == (
        "Blocked: 2 CI check(s) failing. Fix CI before merge."
    )
    assert result.blockers == ["CI Failed: lint", "CI Failed: unit"]
    assert result.summary == (
        "Looks better now.\n\n**⚠️ CI Status:** 2 check(s) failing: lint, unit"
    )


def test_failing_ci_is_not_repeated_on_a_follow_up_that_already_reports_it(followup):
    warning = "\n\n**⚠️ CI Status:** 1 check(s) failing: lint"
    followup.previous()
    followup.context = {"commits_since_review": [{"oid": NEW}]}
    followup.result = lambda: PRReviewResult(
        pr_number=5,
        repo="own/repo",
        success=True,
        summary="Still broken." + warning,
        verdict=MergeVerdict.NEEDS_REVISION,
        overall_status="request_changes",
        blockers=["CI Failed: lint"],
        reviewed_commit_sha=NEW,
    )
    followup.gh.answer({CHECKS: checks(("lint", "FAILURE"))})

    result = followup.run()

    assert result.verdict is MergeVerdict.NEEDS_REVISION
    assert result.blockers == ["CI Failed: lint"]
    assert result.summary == "Still broken." + warning


def test_a_follow_up_without_a_reviewed_commit_still_frees_the_pr(followup):
    followup.previous()
    followup.context = {"commits_since_review": [{"oid": NEW}]}
    followup.result = lambda: PRReviewResult(
        pr_number=5, repo="own/repo", success=True, summary="ok"
    )

    followup.run()

    assert followup.in_progress() == {}


def test_a_follow_up_reviewer_that_crashes_saves_a_failed_follow_up(followup):
    followup.previous()
    followup.context = {"commits_since_review": [{"oid": NEW}]}
    followup.reviewer_error = RuntimeError("model unavailable")

    result = followup.run()

    assert not result.success and result.is_followup_review
    assert result.error == "model unavailable"
    assert PRReviewResult.load(followup.github_dir, 5).error == "model unavailable"
    assert followup.in_progress() == {}
