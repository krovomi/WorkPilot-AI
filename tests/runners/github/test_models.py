"""What the GitHub automation remembers between runs, and how it decides a verdict.

A review, a triage and an auto-fix each leave a JSON file under
`.workpilot/github/` (runners/github/models.py) that the desktop app lists and
the next run reads back; the settings file keeps the choices of the GitHub
settings page without the tokens. The verdict helpers turn a review's findings
and the PR's state (conflicts, branch behind, CI) into the badge the app shows.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from runners.github.models import (
    AICommentTriage,
    AICommentVerdict,
    AutoFixState,
    AutoFixStatus,
    GitHubRunnerConfig,
    MergeVerdict,
    PRReviewFinding,
    PRReviewResult,
    ReviewCategory,
    ReviewSeverity,
    StructuralIssue,
    TriageCategory,
    TriageResult,
    apply_branch_behind_downgrade,
    apply_ci_status_override,
    apply_merge_conflict_override,
    verdict_from_severity_counts,
    verdict_to_github_status,
)

READY = MergeVerdict.READY_TO_MERGE
WITH_CHANGES = MergeVerdict.MERGE_WITH_CHANGES
REVISION = MergeVerdict.NEEDS_REVISION
BLOCKED = MergeVerdict.BLOCKED


def test_the_worst_finding_decides_the_verdict():
    assert verdict_from_severity_counts(critical_count=1, high_count=4) is BLOCKED
    assert verdict_from_severity_counts(high_count=1) is REVISION
    assert verdict_from_severity_counts(medium_count=2) is REVISION
    assert verdict_from_severity_counts(low_count=9) is READY
    assert verdict_from_severity_counts() is READY


def test_a_merge_conflict_blocks_whatever_the_findings_said():
    assert apply_merge_conflict_override(READY, has_merge_conflicts=True) is BLOCKED
    assert apply_merge_conflict_override(READY, has_merge_conflicts=False) is READY


def test_a_branch_behind_its_base_needs_an_update_before_merging():
    assert apply_branch_behind_downgrade(READY, "BEHIND") is REVISION
    assert apply_branch_behind_downgrade(WITH_CHANGES, "BEHIND") is REVISION
    assert apply_branch_behind_downgrade(BLOCKED, "BEHIND") is BLOCKED
    assert apply_branch_behind_downgrade(READY, "CLEAN") is READY


def test_failing_ci_blocks_and_pending_ci_waits():
    assert apply_ci_status_override(READY, failing_count=1) is BLOCKED
    assert apply_ci_status_override(WITH_CHANGES, failing_count=2) is BLOCKED
    assert apply_ci_status_override(REVISION, failing_count=1) is REVISION
    assert apply_ci_status_override(READY, pending_count=1) is REVISION
    assert apply_ci_status_override(BLOCKED, pending_count=1) is BLOCKED
    assert apply_ci_status_override(READY) is READY


def test_each_verdict_maps_to_a_github_review_event():
    assert verdict_to_github_status(BLOCKED) == "request_changes"
    assert verdict_to_github_status(REVISION) == "request_changes"
    assert verdict_to_github_status(WITH_CHANGES) == "comment"
    assert verdict_to_github_status(READY) == "approve"


def test_auto_fix_states_group_into_terminal_recoverable_and_active():
    assert AutoFixStatus.terminal_states() == {
        AutoFixStatus.COMPLETED,
        AutoFixStatus.FAILED,
        AutoFixStatus.CANCELLED,
    }
    assert AutoFixStatus.MERGE_CONFLICT in AutoFixStatus.recoverable_states()
    assert AutoFixStatus.PR_CREATED in AutoFixStatus.active_states()
    assert AutoFixStatus.WAITING_APPROVAL not in AutoFixStatus.active_states()


@pytest.mark.parametrize(
    ("start", "allowed", "refused"),
    [
        ("pending", "analyzing", "building"),
        ("analyzing", "rate_limited", "pr_created"),
        ("creating_spec", "waiting_approval", "completed"),
        ("waiting_approval", "stale", "failed"),
        ("building", "qa_review", "pending"),
        ("qa_review", "building", "stale"),
        ("pr_created", "merge_conflict", "cancelled"),
        ("merge_conflict", "building", "completed"),
        ("stale", "analyzing", "building"),
        ("rate_limited", "pending", "building"),
        ("failed", "pending", "building"),
    ],
)
def test_an_auto_fix_moves_only_along_its_workflow(start, allowed, refused):
    state = AutoFixState(issue_number=1, issue_url="u", repo="o/r")
    state.status = AutoFixStatus(start)
    assert state.status.can_transition_to(AutoFixStatus(allowed))
    assert not state.status.can_transition_to(AutoFixStatus(refused))
    before = state.updated_at
    state.update_status(AutoFixStatus(allowed))
    assert state.status is AutoFixStatus(allowed)
    assert state.updated_at >= before


def test_a_finished_auto_fix_cannot_restart():
    state = AutoFixState(issue_number=1, issue_url="u", repo="o/r")
    for finished in (AutoFixStatus.COMPLETED, AutoFixStatus.CANCELLED):
        state.status = finished
        with pytest.raises(ValueError, match=f"{finished.value} -> pending"):
            state.update_status(AutoFixStatus.PENDING)


def test_an_auto_fix_is_saved_listed_in_the_queue_and_read_back(tmp_path):
    github = tmp_path / ".workpilot" / "github"
    first = AutoFixState(issue_number=4, issue_url="u4", repo="o/r", spec_id="004")
    second = AutoFixState(issue_number=5, issue_url="u5", repo="o/r")
    asyncio.run(first.save(github))
    asyncio.run(second.save(github))
    first.update_status(AutoFixStatus.ANALYZING)
    first.pr_number = 12
    asyncio.run(first.save(github))

    index = json.loads((github / "issues" / "index.json").read_text(encoding="utf-8"))
    queue = {entry["issue_number"]: entry for entry in index["auto_fix_queue"]}
    assert list(queue) == [4, 5]
    assert queue[4]["status"] == "analyzing" and queue[4]["pr_number"] == 12
    assert index["triaged"] == [] and index["last_updated"]

    loaded = AutoFixState.load(github, 4)
    assert loaded.to_dict() == first.to_dict()
    assert AutoFixState.load(github, 99) is None


def test_an_old_auto_fix_file_without_a_url_gets_one(tmp_path):
    state = AutoFixState.from_dict({"issue_number": 3, "repo": "o/r"})
    assert state.issue_url == "https://github.com/o/r/issues/3"
    assert state.status is AutoFixStatus.PENDING
    assert state.bot_comments == []


def test_a_triage_is_saved_and_read_back(tmp_path):
    github = tmp_path / "github"
    result = TriageResult(
        issue_number=8,
        repo="o/r",
        category=TriageCategory.DUPLICATE,
        confidence=0.9,
        is_duplicate=True,
        duplicate_of=2,
        labels_to_add=["duplicate"],
        comment="Same as #2",
    )
    asyncio.run(result.save(github))
    loaded = TriageResult.load(github, 8)
    assert loaded.to_dict() == result.to_dict()
    assert TriageResult.load(github, 9) is None

    sparse = TriageResult.from_dict(
        {"issue_number": 1, "repo": "o/r", "category": "bug", "confidence": 0.4}
    )
    assert sparse.priority == "medium" and sparse.labels_to_add == []


def _finding(**extra) -> PRReviewFinding:
    return PRReviewFinding(
        id="f1",
        severity=ReviewSeverity.HIGH,
        category=ReviewCategory.SECURITY,
        title="SQL built by hand",
        description="d",
        file="db.py",
        line=3,
        **extra,
    )


def test_a_review_keeps_everything_it_found_across_a_save(tmp_path):
    github = tmp_path / "github"
    review = PRReviewResult(
        pr_number=7,
        repo="o/r",
        success=True,
        findings=[_finding(evidence="cursor.execute(f'...')", learned_rejections=2)],
        structural_issues=[
            StructuralIssue(
                id="s1",
                issue_type="scope_creep",
                severity=ReviewSeverity.MEDIUM,
                title="Two features",
                description="d",
                impact="i",
                suggestion="split",
            )
        ],
        ai_comment_triages=[
            AICommentTriage(
                comment_id=4,
                tool_name="CodeRabbit",
                original_comment="nit",
                verdict=AICommentVerdict.FALSE_POSITIVE,
                reasoning="wrong",
            )
        ],
        verdict=BLOCKED,
    )
    asyncio.run(review.save(github))
    review.summary = "second pass"
    asyncio.run(review.save(github))
    asyncio.run(PRReviewResult(pr_number=8, repo="o/r", success=True).save(github))

    loaded = PRReviewResult.load(github, 7)
    assert loaded.to_dict() == review.to_dict()
    assert loaded.findings[0].learned_rejections == 2
    index = json.loads((github / "pr" / "index.json").read_text(encoding="utf-8"))
    assert [entry["pr_number"] for entry in index["reviews"]] == [7, 8]
    assert index["reviews"][0]["findings_count"] == 1
    assert PRReviewResult.load(github, 99) is None


def test_a_finding_from_an_older_file_takes_the_defaults():
    finding = PRReviewFinding.from_dict(
        {
            "id": "f",
            "severity": "low",
            "category": "style",
            "title": "t",
            "description": "d",
            "file": "a.py",
            "line": 1,
            "learned_rejections": None,
        }
    )
    assert finding.learned_rejections == 0
    assert finding.source_agents == [] and finding.confidence == 0.5


def test_settings_are_saved_without_the_tokens(tmp_path):
    github = tmp_path / "github"
    config = GitHubRunnerConfig(
        token="t0k",  # pragma: allowlist secret
        repo="o/r",
        bot_token="b0t",  # pragma: allowlist secret
        auto_fix_enabled=True,
        auto_fix_labels=["fix-me"],
        duplicate_threshold=0.9,
        model="opus",
    )
    assert config.to_dict()["token"] == "***"
    assert config.to_dict()["bot_token"] == "***"
    assert GitHubRunnerConfig(token="t", repo="o/r").to_dict()["bot_token"] is None

    config.save_settings(github)
    saved = (github / "config.json").read_text(encoding="utf-8")
    assert "t0k" not in saved and "b0t" not in saved
    assert "token" not in json.loads(saved)

    loaded = GitHubRunnerConfig.load_settings(github, token="new", repo="o/r")
    assert loaded.token == "new" and loaded.bot_token is None
    assert loaded.auto_fix_enabled is True
    assert loaded.auto_fix_labels == ["fix-me"]
    assert loaded.duplicate_threshold == 0.9
    assert loaded.model == "opus"


def test_without_a_settings_file_the_defaults_apply(tmp_path):
    loaded = GitHubRunnerConfig.load_settings(tmp_path, token="t", repo="o/r")
    assert loaded.to_dict() == GitHubRunnerConfig(token="t", repo="o/r").to_dict()
