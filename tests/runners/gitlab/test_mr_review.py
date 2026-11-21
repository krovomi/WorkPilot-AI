"""The AI review of a GitLab merge request, and its follow-up.

The app asks for a review of MR !N: the orchestrator reads the MR, its
changes and its commits from GitLab, has a model review the diff, turns the
answer into findings and a merge verdict, and saves the review under
``.workpilot/gitlab/mr/review_N.json``, where the app reads it. A follow-up
review compares a later state of the MR with the saved one.

GitLab is a local HTTP server, the model a stand-in that streams its answer;
the project folder, the saved reviews and the code under test are real.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import socket
from pathlib import Path

import pytest
from runners.gitlab.models import GitLabRunnerConfig, MergeVerdict, MRReviewResult
from runners.gitlab.orchestrator import GitLabOrchestrator


@pytest.fixture
def project(tmp_path):
    project = tmp_path / "shop"
    project.mkdir()
    return project


@pytest.fixture
def review(project, gitlab):
    """An orchestrator for the project, pointed at the fake GitLab."""
    progress = []

    def make(instance: str | None = None) -> GitLabOrchestrator:
        config = GitLabRunnerConfig(
            token=gitlab.token,
            project=gitlab.project,
            instance_url=instance or gitlab.url,
            model="some-model",
        )
        return GitLabOrchestrator(project, config, progress_callback=progress.append)

    make.progress = progress
    return make


def saved(project, iid: int) -> dict:
    path = project / ".workpilot" / "gitlab" / "mr" / f"review_{iid}.json"
    return json.loads(path.read_text(encoding="utf-8"))


class TestAReview:
    def test_the_mr_is_read_from_gitlab_reviewed_and_saved(
        self, project, gitlab, model, llm, review
    ):
        gitlab.serve_mr(7)
        stand_in = model(
            llm.says(
                llm.review(
                    "needs_revision",
                    [
                        llm.finding("Rate limit is always true", "high"),
                        llm.finding("Name the constant", "low", category="style"),
                    ],
                    summary="The limiter does not limit.",
                )
            )
        )

        result = asyncio.run(review().review_mr(7))

        assert result.success, result.error
        assert [f.title for f in result.findings] == [
            "Rate limit is always true",
            "Name the constant",
        ]
        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert result.overall_status == "request_changes"
        assert result.blockers == ["Rate limit is always true (app/login.py:2)"]
        assert result.reviewed_commit_sha == "abc1234def5678"
        assert "The limiter does not limit." in result.summary
        assert saved(project, 7)["findings"][0]["severity"] == "high"
        # Each call carries the token, and reads only this project's MR
        assert {r.headers["private-token"] for r in gitlab.requests} == {gitlab.token}
        assert [r.path for r in gitlab.requests] == [
            f"{gitlab.api}/merge_requests/7",
            f"{gitlab.api}/merge_requests/7/changes",
            f"{gitlab.api}/merge_requests/7/commits",
        ]
        # The model was asked as a read-only reviewer, with the MR in its prompt
        assert stand_in.created_with["agent_type"] == "pr_reviewer"
        assert stand_in.created_with["model"] == "some-model"
        prompt = stand_in.prompts[0]
        assert "Add login rate limit" in prompt
        assert "+    check_rate(ip)" in prompt
        assert "4 additions, 1 deletions across 2 files" in prompt
        assert "\n- app/rate.py\n" in prompt

    def test_progress_is_reported_from_gathering_to_complete(
        self, gitlab, model, llm, review
    ):
        gitlab.serve_mr(7)
        model(llm.says(llm.review()))
        orchestrator = review()

        asyncio.run(orchestrator.review_mr(7))

        assert [(p.phase, p.progress) for p in review.progress] == [
            ("gathering_context", 10),
            ("analyzing", 30),
            ("analyzing", 30),
            ("analyzing", 70),
            ("complete", 100),
        ]
        assert {p.mr_iid for p in review.progress} == {7}

    def test_a_review_runs_without_a_progress_listener(
        self, project, gitlab, model, llm
    ):
        gitlab.serve_mr(7)
        model(llm.says(llm.review("blocked")))
        config = GitLabRunnerConfig(
            token=gitlab.token, project=gitlab.project, instance_url=gitlab.url
        )

        result = asyncio.run(GitLabOrchestrator(project, config).review_mr(7))

        assert result.overall_status == "request_changes"

    @pytest.mark.parametrize(
        ("verdict", "status"),
        [
            ("ready_to_merge", "approve"),
            ("merge_with_changes", "comment"),
            ("needs_revision", "request_changes"),
            ("blocked", "request_changes"),
        ],
    )
    def test_the_verdict_decides_what_the_mr_is_told(
        self, gitlab, model, llm, review, verdict, status
    ):
        gitlab.serve_mr(7)
        model(llm.says(llm.review(verdict)))

        result = asyncio.run(review().review_mr(7))

        assert result.verdict.value == verdict
        assert result.overall_status == status

    def test_an_answer_streamed_in_pieces_is_read_whole(
        self, gitlab, model, llm, review
    ):
        gitlab.serve_mr(7)
        answer = llm.review("blocked", [llm.finding("SQL injection", "critical")])
        middle = len(answer) // 2
        model(llm.says(answer[:middle], answer[middle:]))

        result = asyncio.run(review().review_mr(7))

        assert result.verdict == MergeVerdict.BLOCKED
        assert [f.title for f in result.findings] == ["SQL injection"]

    def test_an_answer_without_a_readable_review_does_not_approve_the_mr(
        self, project, gitlab, model, llm, review
    ):
        gitlab.serve_mr(7)
        model(llm.says("I looked at it and it seems fine to me."))

        result = asyncio.run(review().review_mr(7))

        assert result.success
        assert result.findings == []
        assert result.verdict == MergeVerdict.MERGE_WITH_CHANGES
        assert result.overall_status == "comment"
        assert "Please re-run the review" in result.summary

    def test_an_mr_without_a_head_sha_takes_it_from_its_diff_refs(
        self, gitlab, model, llm, review
    ):
        gitlab.serve_mr(7, sha=None, diff_refs={"head_sha": "fedcba9876"})
        model(llm.says(llm.review()))

        result = asyncio.run(review().review_mr(7))

        assert result.reviewed_commit_sha == "fedcba9876"

    def test_an_mr_without_a_description_is_reviewed_as_such(
        self, gitlab, model, llm, review
    ):
        gitlab.serve_mr(7, description=None, changes=[])
        stand_in = model(llm.says(llm.review()))

        result = asyncio.run(review().review_mr(7))

        assert result.success
        assert "No description provided." in stand_in.prompts[0]
        assert "0 additions, 0 deletions across 0 files" in stand_in.prompts[0]

    def test_a_file_renamed_without_changes_is_still_listed(
        self, gitlab, model, llm, review
    ):
        gitlab.serve_mr(
            7,
            changes=[{"old_path": "old.py", "new_path": "new.py", "diff": ""}],
        )
        stand_in = model(llm.says(llm.review()))

        asyncio.run(review().review_mr(7))

        assert "\n- new.py\n" in stand_in.prompts[0]

    def test_high_findings_are_remembered_for_the_next_review(
        self, gitlab, model, llm, review
    ):
        gitlab.serve_mr(7)
        model(
            llm.says(
                llm.review(
                    "blocked",
                    [llm.finding("Token in logs", "high"), llm.finding("Nit", "low")],
                )
            )
        )

        result = asyncio.run(review().review_mr(7))

        assert result.success
        brain = Path(os.environ["WORKPILOT_BRAIN_DIR"])
        notes = [p.read_text(encoding="utf-8") for p in brain.rglob("*.md")]
        assert any("Token in logs" in note for note in notes)
        assert not any("Nit (`app/login.py`)" in note for note in notes)


class TestAReviewThatCannotBeDone:
    @pytest.mark.parametrize(
        ("status", "message"),
        [
            (401, "GitLab authentication failed. Check your token."),
            (403, "GitLab access forbidden. Check your permissions."),
            (404, "MR !7 not found in GitLab."),
            (500, "GitLab API error 500"),
        ],
    )
    def test_a_gitlab_refusal_is_told_in_plain_words_and_saved(
        self, project, gitlab, review, status, message
    ):
        gitlab.answer(
            "GET",
            f"{gitlab.api}/merge_requests/7",
            gitlab.Answer(status, {"message": "nope"}),
        )

        result = asyncio.run(review().review_mr(7))

        assert not result.success
        assert result.error == message
        assert saved(project, 7)["error"] == message

    def test_rate_limiting_is_retried_then_reported(self, gitlab, review):
        gitlab.answer(
            "GET",
            f"{gitlab.api}/merge_requests/7",
            gitlab.Answer(429, {"message": "slow down"}, headers={"Retry-After": "0"}),
        )

        result = asyncio.run(review().review_mr(7))

        assert result.error == "GitLab rate limit exceeded. Please try again later."
        assert len(gitlab.requests) == 3

    def test_an_unreachable_instance_is_named(self, review):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            closed = f"http://127.0.0.1:{probe.getsockname()[1]}"

        result = asyncio.run(review(instance=closed).review_mr(7))

        assert not result.success
        assert result.error.startswith(f"Could not reach GitLab at {closed}: ")

    def test_an_answer_that_is_not_json_is_reported(self, gitlab, review):
        gitlab.answer(
            "GET",
            f"{gitlab.api}/merge_requests/7",
            gitlab.Answer(raw=b"<html>maintenance</html>"),
        )

        result = asyncio.run(review().review_mr(7))

        assert result.error.startswith("Invalid JSON response from GitLab: ")

    def test_a_model_failure_fails_the_review_with_its_cause(
        self, project, gitlab, model, review
    ):
        gitlab.serve_mr(7)
        model(fail=ConnectionError("provider down"))

        result = asyncio.run(review().review_mr(7))

        assert not result.success
        assert result.error.startswith(
            "RuntimeError: Review failed: provider down\n\nTraceback:\n"
        )
        assert saved(project, 7)["success"] is False


class TestWhatTheReviewDoesNotDependOn:
    """Codebase context and the shared memory help a review; neither can fail it."""

    def test_a_failing_codebase_context_does_not_fail_the_review(
        self, gitlab, model, llm, review
    ):
        class Broken:
            async def gather_deep_context(self, **kwargs):
                raise RuntimeError("index unavailable")

        gitlab.serve_mr(7)
        model(llm.says(llm.review()))
        orchestrator = review()
        orchestrator.deep_context_provider = Broken()

        result = asyncio.run(orchestrator.review_mr(7))

        assert result.success
        assert result.deep_context == {}

    def test_a_failing_memory_does_not_fail_the_review(
        self, gitlab, model, llm, review, monkeypatch
    ):
        async def broken(**kwargs):
            raise RuntimeError("vault locked")

        orchestrator_module = importlib.import_module("runners.gitlab.orchestrator")
        monkeypatch.setattr(orchestrator_module, "store_review_learnings", broken)
        gitlab.serve_mr(7)
        model(llm.says(llm.review("blocked", [llm.finding("Leak", "critical")])))

        result = asyncio.run(review().review_mr(7))

        assert result.success
        assert [f.title for f in result.findings] == ["Leak"]


def _seed(project, **fields) -> MRReviewResult:
    previous = MRReviewResult(
        mr_iid=7,
        project="group/app",
        success=True,
        reviewed_commit_sha="abc1234def5678",
        **fields,
    )
    previous.save(project / ".workpilot" / "gitlab")
    return previous


class TestAFollowUpReview:
    def test_it_needs_a_first_review(self, review):
        with pytest.raises(ValueError, match="Run initial review first"):
            asyncio.run(review().followup_review_mr(7))

    def test_it_needs_the_commit_the_first_review_saw(self, project, review):
        MRReviewResult(mr_iid=7, project="group/app", success=False).save(
            project / ".workpilot" / "gitlab"
        )

        with pytest.raises(ValueError, match="doesn't have commit SHA"):
            asyncio.run(review().followup_review_mr(7))

    def test_without_new_commits_the_previous_findings_still_apply(
        self, project, gitlab, model, review
    ):
        from runners.gitlab.models import (
            MRReviewFinding,
            ReviewCategory,
            ReviewSeverity,
        )

        old = MRReviewFinding(
            "finding-1",
            ReviewSeverity.HIGH,
            ReviewCategory.SECURITY,
            "Leak",
            "d",
            "a.py",
            3,
        )
        _seed(
            project,
            findings=[old],
            verdict=MergeVerdict.BLOCKED,
            overall_status="request_changes",
        )
        gitlab.serve_mr(7)  # same head sha
        stand_in = model()

        result = asyncio.run(review().followup_review_mr(7))

        assert stand_in.prompts == []  # the model is not asked again
        assert result.success and result.is_followup_review
        assert result.unresolved_findings == ["finding-1"]
        assert result.verdict == MergeVerdict.BLOCKED
        assert result.overall_status == "request_changes"
        assert saved(project, 7)["summary"].startswith("No new commits")

    def test_new_commits_are_compared_with_the_previous_findings(
        self, project, gitlab, model, llm, review
    ):
        from runners.gitlab.models import (
            MRReviewFinding,
            ReviewCategory,
            ReviewSeverity,
        )

        def old(title):
            return MRReviewFinding(
                title, ReviewSeverity.MEDIUM, ReviewCategory.QUALITY, title, "", "a", 1
            )

        _seed(project, findings=[old("Fixed one"), old("Still there")])
        gitlab.serve_mr(7, sha="0ddc0ffee")
        model(
            llm.says(
                llm.review(
                    "merge_with_changes",
                    [llm.finding("Still there"), llm.finding("Brand new")],
                )
            )
        )

        result = asyncio.run(review().followup_review_mr(7))

        assert result.success and result.is_followup_review
        assert result.resolved_findings == ["Fixed one"]
        assert result.unresolved_findings == ["Still there"]
        assert result.new_findings_since_last_review == ["Brand new"]
        assert result.reviewed_commit_sha == "0ddc0ffee"
        assert result.overall_status == "comment"
        assert result.summary.startswith("### Follow-up Review")
        assert "**Resolved**: 1 finding(s)" in result.summary
        assert review.progress[-1].phase == "complete"

    def test_a_gitlab_refusal_is_told_in_plain_words(self, project, gitlab, review):
        _seed(project)
        gitlab.answer("GET", f"{gitlab.api}/merge_requests/7", gitlab.Answer(401, {}))

        result = asyncio.run(review().followup_review_mr(7))

        assert result.error == "GitLab authentication failed. Check your token."
        assert result.is_followup_review
        assert saved(project, 7)["is_followup_review"] is True

    def test_an_answer_that_is_not_json_is_reported(self, project, gitlab, review):
        _seed(project)
        gitlab.answer(
            "GET", f"{gitlab.api}/merge_requests/7", gitlab.Answer(raw=b"{oops")
        )

        result = asyncio.run(review().followup_review_mr(7))

        assert result.error.startswith("Invalid JSON response from GitLab: ")

    def test_a_model_failure_is_reported(self, project, gitlab, model, review):
        _seed(project)
        gitlab.serve_mr(7, sha="0ddc0ffee")
        model(fail=ConnectionError("provider down"))

        result = asyncio.run(review().followup_review_mr(7))

        assert result.error == "RuntimeError: Review failed: provider down"
        assert result.is_followup_review
