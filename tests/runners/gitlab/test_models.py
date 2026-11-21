"""The saved GitLab MR review, as the app reads it back.

A review is written to ``.workpilot/gitlab/mr/review_<iid>.json`` and read
again by the follow-up review and by the app; the runner's configuration can
be written out without its token.
"""

from __future__ import annotations

from runners.gitlab.models import (
    GitLabRunnerConfig,
    MergeVerdict,
    MRReviewFinding,
    MRReviewResult,
    ReviewCategory,
    ReviewSeverity,
)


def test_a_saved_review_reads_back_the_same(tmp_path):
    review = MRReviewResult(
        mr_iid=12,
        project="group/app",
        success=True,
        findings=[
            MRReviewFinding(
                "finding-1",
                ReviewSeverity.CRITICAL,
                ReviewCategory.SECURITY,
                "Secret in config",
                "A key is committed.",
                "config.py",
                4,
                end_line=6,
                suggested_fix="Read it from the environment.",
                fixable=True,
            )
        ],
        summary="Blocked.",
        overall_status="request_changes",
        verdict=MergeVerdict.BLOCKED,
        blockers=["Secret in config (config.py:4)"],
        reviewed_commit_sha="abc",
        is_followup_review=True,
        previous_review_id=3,
        resolved_findings=["a"],
        unresolved_findings=["b"],
        new_findings_since_last_review=["c"],
        has_posted_findings=True,
        posted_finding_ids=["finding-1"],
        deep_context={"context_available": True},
        jev={"status": "bypassed"},
    )

    review.save(tmp_path)

    assert (tmp_path / "mr" / "review_12.json").exists()
    assert MRReviewResult.load(tmp_path, 12) == review


def test_a_review_with_only_the_required_fields_gets_the_defaults():
    review = MRReviewResult.from_dict(
        {"mr_iid": 1, "project": "group/app", "success": False}
    )

    assert review.findings == []
    assert review.overall_status == "comment"
    assert review.verdict == MergeVerdict.READY_TO_MERGE
    assert review.reviewed_commit_sha is None
    assert review.is_followup_review is False
    assert review.jev is None


def test_an_mr_never_reviewed_has_no_saved_review(tmp_path):
    assert MRReviewResult.load(tmp_path, 99) is None


def test_the_written_configuration_never_holds_the_token():
    config = GitLabRunnerConfig(
        token="glpat-real-looking-0000",  # pragma: allowlist secret
        project="group/app",
        instance_url="https://git.example.org",
    )

    written = config.to_dict()

    assert written["token"] == "***"
    assert "glpat-real-looking-0000" not in str(written)  # pragma: allowlist secret
    assert written["project"] == "group/app"
    assert written["instance_url"] == "https://git.example.org"
