"""Reviewing a pull request from the desktop app's GitHub view.

`GitHubOrchestrator.review_pr` gathers the PR, asks the review engine for
findings, reads the CI checks, decides the merge verdict, writes the summary
the app shows, saves the review under `.workpilot/github/pr/`, optionally
posts it on GitHub, and remembers which commit it reviewed so a second click
does not run the model again.

What stands in: `gh` (tests/gh_fake.py), the context gatherer and the review
engine (another suite covers both; here they hand over a real `PRContext`
and real findings), the deep-context provider and the review memory. The bot
detector, the learned-suppression rules, the CI and file reads, the result
files and the posting are the real ones.
"""

from __future__ import annotations

import asyncio
import importlib
import json
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest
from runners.github.context_gatherer import ChangedFile, PRContext
from runners.github.models import (
    BRANCH_BEHIND_BLOCKER_MSG,
    BRANCH_BEHIND_REASONING,
    AICommentTriage,
    AICommentVerdict,
    MergeVerdict,
    PRReviewFinding,
    PRReviewResult,
    ReviewCategory,
    ReviewSeverity,
    StructuralIssue,
)
from runners.github.services.deep_context_provider import DeepContext

HEAD = "bbb222ccc333"
CHECKS = "pr checks 5 --json name,state -R own/repo"
HEAD_OID = "pr view 5 --json headRefOid -R own/repo"
RUNS = "api --method GET repos/{owner}/{repo}/actions/runs?status=action_required&per_page=100"
FILES = "api --method GET repos/{owner}/{repo}/pulls/5/files?page=1&per_page=100"


def finding(
    fid="f1",
    severity=ReviewSeverity.MEDIUM,
    category=ReviewCategory.QUALITY,
    title="Possible None dereference",
    **extra,
) -> PRReviewFinding:
    return PRReviewFinding(
        id=fid,
        severity=severity,
        category=category,
        title=title,
        description="d",
        file="src/cache.py",
        line=12,
        **extra,
    )


def structural(
    sid="s1",
    severity=ReviewSeverity.HIGH,
    issue_type="poor_structure",
    title="God object",
) -> StructuralIssue:
    return StructuralIssue(
        id=sid,
        issue_type=issue_type,
        severity=severity,
        title=title,
        description="Does too much",
        impact="Hard to change",
        suggestion="Split it",
    )


def triage(
    cid=77,
    verdict=AICommentVerdict.IMPORTANT,
    comment="Consider caching this lookup",
    response="Agreed, fixed in the next commit.",
) -> AICommentTriage:
    return AICommentTriage(
        comment_id=cid,
        tool_name="CodeRabbit",
        original_comment=comment,
        verdict=verdict,
        reasoning="r",
        response_comment=response,
    )


def context(**overrides) -> PRContext:
    values = {
        "pr_number": 5,
        "title": "Add a read cache",
        "description": "Speeds up reads",
        "author": "alice",
        "base_branch": "develop",
        "head_branch": "feat/cache",
        "state": "open",
        "changed_files": [
            ChangedFile("src/cache.py", "modified", 30, 2, "", "", "@@ -1 +1 @@")
        ],
        "diff": "@@ -1 +1 @@\n-x\n+y",
        "repo_structure": "",
        "related_files": ["tests/test_cache.py"],
        "commits": [{"oid": "aaa111"}, {"oid": HEAD}],
        "total_additions": 30,
        "total_deletions": 2,
        "head_sha": HEAD,
    }
    values.update(overrides)
    return PRContext(**values)


class _Engine:
    """The review engine's seam: `run_multi_pass_review(context)`."""

    def __init__(self, state):
        self.state = state

    async def run_multi_pass_review(self, pr_context):
        self.state.engine_calls.append(pr_context)
        if self.state.engine_error:
            raise self.state.engine_error
        return (
            list(self.state.findings),
            list(self.state.structural),
            list(self.state.triages),
            {"verdict": "quick"},
        )


class _Deep:
    def __init__(self, state):
        self.state = state

    async def gather_deep_context(self, **request):
        self.state.deep_requests.append(request)
        if isinstance(self.state.deep, BaseException):
            raise self.state.deep
        return self.state.deep


@pytest.fixture
def review(orchestrator, gh, monkeypatch):
    """A PR #5 to review, and what the review saw and did."""
    module = importlib.import_module("runners.github.orchestrator")
    state = SimpleNamespace(
        context=context(),
        findings=[],
        structural=[],
        triages=[],
        engine_error=None,
        engine_calls=[],
        deep=DeepContext(
            project_patterns={"naming": "snake"},
            historical_insights=[{"note": "cache bugs before"}],
            context_available=True,
        ),
        deep_requests=[],
        gathered=[],
        learnings=[],
        learnings_error=None,
        gh=gh,
        project=orchestrator.project,
        github_dir=orchestrator.project / ".workpilot" / "github",
        progress=orchestrator.progress,
        hermes=orchestrator.hermes,
    )

    class Gatherer:
        def __init__(self, project_dir, pr_number, repo=None):
            state.gathered.append((Path(project_dir), pr_number, repo))

        async def gather(self):
            return state.context

    async def store_review_learnings(**learning):
        if state.learnings_error:
            raise state.learnings_error
        state.learnings.append(learning)

    monkeypatch.setattr(module, "PRContextGatherer", Gatherer)
    monkeypatch.setattr(module, "store_review_learnings", store_review_learnings)

    def build(**config):
        orch = orchestrator(**config)
        orch.pr_review_engine = _Engine(state)
        orch.deep_context_provider = _Deep(state)
        return orch

    def run(force_review=False, **config):
        return asyncio.run(build(**config).review_pr(5, force_review=force_review))

    def bot_state():
        path = state.github_dir / "bot_detection_state.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def write_bot_state(**fields):
        state.github_dir.mkdir(parents=True, exist_ok=True)
        data = {
            "reviewed_commits": {},
            "last_review_times": {},
            "in_progress_reviews": {},
        }
        data.update(fields)
        (state.github_dir / "bot_detection_state.json").write_text(
            json.dumps(data), encoding="utf-8"
        )

    state.build, state.run = build, run
    state.bot_state, state.write_bot_state = bot_state, write_bot_state
    gh.answer({})
    return state


def checks(*states: tuple[str, str]) -> dict:
    return {"stdout": json.dumps([{"name": name, "state": st} for name, st in states])}


def posted(gh) -> list[list[str]]:
    return [c for c in gh.calls() if c[:2] == ["pr", "review"] or "POST" in c]


# ---------------------------------------------------------------------------
# The happy path: what is fetched, saved and remembered
# ---------------------------------------------------------------------------


def test_a_clean_pr_is_approved_saved_and_remembered(review):
    review.gh.answer(
        {
            CHECKS: checks(("lint", "SUCCESS"), ("unit", "NEUTRAL")),
            HEAD_OID: {"stdout": json.dumps({"headRefOid": HEAD})},
            RUNS: {"stdout": json.dumps({"workflow_runs": []})},
            FILES: {
                "stdout": json.dumps(
                    [
                        {"filename": "src/cache.py", "sha": "blob1"},
                        {"filename": "", "sha": "ignored"},
                        {"filename": "README.md"},
                    ]
                )
            },
        }
    )

    result = review.run()

    assert result.success, result.error
    assert result.verdict is MergeVerdict.READY_TO_MERGE
    assert result.overall_status == "approve"
    assert result.verdict_reasoning == "No blocking issues found"
    assert result.blockers == []
    assert "> **✅ Ready to merge** - All checks passing" in result.summary
    assert result.summary.endswith("_Generated by WorkPilot AI PR Review_")
    assert result.reviewed_commit_sha == HEAD
    assert result.reviewed_file_blobs == {"src/cache.py": "blob1"}
    assert result.quick_scan_summary == {"verdict": "quick"}
    assert result.risk_assessment == {
        "complexity": "low",
        "security_impact": "none",
        "scope_coherence": "good",
    }
    assert result.deep_context["project_patterns"] == {"naming": "snake"}
    assert result.review_id is None
    # Gathered for the configured repo, with the deep context asked for the
    # PR's own title and files.
    assert review.gathered == [(review.project, 5, "own/repo")]
    assert review.deep_requests[0]["changed_file_paths"] == ["src/cache.py"]
    assert review.deep_requests[0]["pr_title"] == "Add a read cache"
    # Saved, and what the app reads back is the same review.
    saved = PRReviewResult.load(review.github_dir, 5)
    assert saved.summary == result.summary and saved.success
    # The reviewed commit is remembered and the PR is no longer in progress.
    assert review.bot_state()["reviewed_commits"] == {"5": [HEAD]}
    assert review.bot_state()["in_progress_reviews"] == {}
    assert review.learnings == [
        {
            "project_dir": review.project,
            "pr_number": 5,
            "findings": [],
            "pr_title": "Add a read cache",
            "changed_files": ["src/cache.py"],
        }
    ]
    # hermes turns once, after the review is on disk.
    assert review.hermes == [True]
    assert [(p.phase, p.progress) for p in review.progress] == [
        ("gathering_context", 10),
        ("analyzing", 30),
        ("generating", 70),
        ("complete", 100),
    ]
    assert all(p.pr_number == 5 for p in review.progress)
    # Nothing is posted unless the project asks for it.
    assert posted(review.gh) == []


def test_without_a_progress_listener_the_review_still_runs(review):
    result = review.run(report_progress=False)

    assert result.success
    assert review.progress == []


def test_the_review_is_posted_with_its_verdict_and_the_ai_comments_answered(review):
    review.findings = [finding(severity=ReviewSeverity.HIGH)]
    review.triages = [
        triage(77, AICommentVerdict.IMPORTANT, response="Agreed, fixed."),
        triage(78, AICommentVerdict.TRIVIAL, response="Nit, ignoring."),
        triage(79, AICommentVerdict.CRITICAL, response=None),
        triage(80, AICommentVerdict.NICE_TO_HAVE, response="Will not reply"),
    ]
    reply = "api --method POST repos/own/repo/pulls/5/comments/{}/replies"
    review.gh.answer(
        {
            "pr review 5": {"stdout": ""},
            reply.format(77): {"stdout": "{}"},
            reply.format(80): {"stderr": "HTTP 404: Not Found", "code": 1},
        }
    )

    result = review.run(auto_post_reviews=True)

    assert result.verdict is MergeVerdict.NEEDS_REVISION
    assert result.overall_status == "request_changes"
    assert result.review_id == 0
    calls = posted(review.gh)
    assert calls[0] == [
        "pr",
        "review",
        "5",
        "--request-changes",
        "--body",
        result.summary,
        "-R",
        "own/repo",
    ]
    # Replies go to the comment's thread, as a literal field; trivial verdicts
    # and triages without a reply are left alone, a refused reply is skipped.
    assert calls[1:] == [
        [*reply.format(77).split(), "-f", "body=Agreed, fixed."],
        [*reply.format(80).split(), "-f", "body=Will not reply"],
    ]
    assert [p.progress for p in review.progress if p.phase == "posting"] == [90, 95]
    assert PRReviewResult.load(review.github_dir, 5).review_id == 0


def test_an_approved_review_is_posted_as_an_approval(review):
    review.gh.answer({"pr review 5": {"stdout": ""}})

    result = review.run(auto_post_reviews=True)

    assert result.overall_status == "approve"
    assert posted(review.gh)[0][3] == "--approve"
    # No AI comments to answer: no second posting step.
    assert [p.progress for p in review.progress if p.phase == "posting"] == [90]


# ---------------------------------------------------------------------------
# When the review is skipped, or ran before
# ---------------------------------------------------------------------------


def test_a_pr_opened_by_the_bot_account_is_not_reviewed(review):
    review.gh.answer({"api user": {"stdout": json.dumps({"login": "alice"})}})

    result = review.run(bot_token="placeholder-bot")  # pragma: allowlist secret

    assert result.success
    assert result.summary == "Skipped review: PR authored by bot user (alice)"
    assert review.engine_calls == []
    assert PRReviewResult.load(review.github_dir, 5).summary == result.summary


def test_a_pr_with_a_review_in_progress_is_not_reviewed_twice(review):
    review.write_bot_state(in_progress_reviews={"5": datetime.now().isoformat()})

    result = review.run()

    assert result.summary.startswith("Skipped review: Review already in progress")
    assert review.engine_calls == []


def _reviewed_before(review):
    review.write_bot_state(reviewed_commits={"5": [HEAD]})


def test_an_already_reviewed_commit_returns_the_saved_review_unchanged(review):
    _reviewed_before(review)
    earlier = PRReviewResult(
        pr_number=5, repo="own/repo", success=True, summary="Earlier review"
    )
    asyncio.run(earlier.save(review.github_dir))

    result = review.run()

    assert result.summary == "Earlier review"
    assert review.engine_calls == []
    assert PRReviewResult.load(review.github_dir, 5).summary == "Earlier review"


def test_an_already_reviewed_commit_without_a_saved_review_gets_a_skip_result(review):
    _reviewed_before(review)

    result = review.run()

    assert result.summary == f"Skipped review: Already reviewed commit {HEAD[:8]}"
    assert review.engine_calls == []


def test_a_previous_review_that_failed_does_not_block_a_new_one(review):
    _reviewed_before(review)
    failed = PRReviewResult(pr_number=5, repo="own/repo", success=False, error="x")
    asyncio.run(failed.save(review.github_dir))

    result = review.run()

    assert result.success and len(review.engine_calls) == 1


def test_a_forced_review_runs_again_on_an_already_reviewed_commit(review):
    _reviewed_before(review)

    result = review.run(force_review=True)

    assert result.success and len(review.engine_calls) == 1
    assert result.summary.startswith("### Merge Verdict")


def test_a_pr_without_commits_is_not_left_in_progress(review):
    review.context = context(commits=[])

    first = review.run()
    second = review.run()

    assert first.success and first.reviewed_commit_sha is None
    assert review.bot_state()["in_progress_reviews"] == {}
    # The second request is a real review, not "already in progress".
    assert second.summary.startswith("### Merge Verdict")
    assert len(review.engine_calls) == 2


# ---------------------------------------------------------------------------
# Failures on the way
# ---------------------------------------------------------------------------


def test_a_review_that_crashes_is_saved_as_failed_and_frees_the_pr(review):
    review.engine_error = RuntimeError("model unavailable")

    result = review.run()

    assert not result.success
    assert result.error.startswith("RuntimeError: model unavailable")
    assert "Traceback:" in result.error
    assert PRReviewResult.load(review.github_dir, 5).success is False
    assert review.bot_state()["in_progress_reviews"] == {}
    assert review.hermes == []


def test_the_review_goes_on_without_deep_context(review):
    review.deep = TimeoutError("too slow")

    result = review.run()

    assert result.success and result.deep_context == {}


def test_the_review_goes_on_when_its_memory_cannot_be_written(review):
    review.findings = [finding()]
    review.learnings_error = OSError("disk full")

    result = review.run()

    assert result.success
    assert PRReviewResult.load(review.github_dir, 5).findings[0].id == "f1"


def test_the_review_goes_on_without_the_file_blobs(review):
    review.gh.answer({FILES: {"stderr": "HTTP 500", "code": 1}})

    result = review.run()

    assert result.success and result.reviewed_file_blobs == {}


# ---------------------------------------------------------------------------
# CI on the PR
# ---------------------------------------------------------------------------


def test_failing_ci_blocks_the_merge(review):
    review.gh.answer(
        {CHECKS: checks(("lint", "FAILURE"), ("unit", "SUCCESS"), ("e2e", "QUEUED"))}
    )

    result = review.run()

    assert result.verdict is MergeVerdict.BLOCKED
    assert result.blockers == ["CI Failed: lint"]
    assert result.verdict_reasoning == (
        "Blocked: 1 CI check(s) failing. Fix CI before merge."
    )
    assert "> **🔴 Blocked** - 1 CI check(s) failing." in result.summary
    assert "### 🚨 Blocking Issues (Must Fix)\n- CI Failed: lint" in result.summary


def test_fork_workflows_awaiting_approval_block_the_merge(review):
    review.gh.answer(
        {
            HEAD_OID: {"stdout": json.dumps({"headRefOid": HEAD})},
            RUNS: {
                "stdout": json.dumps(
                    {
                        "workflow_runs": [
                            {"id": 1, "name": "CI", "head_sha": HEAD},
                            {"id": 2, "name": "CI", "head_sha": "other"},
                        ]
                    }
                )
            },
        }
    )

    result = review.run()

    assert result.verdict is MergeVerdict.BLOCKED
    assert result.blockers == [
        "Workflows Pending: 1 workflow(s) awaiting maintainer approval"
    ]
    assert result.verdict_reasoning.startswith("Blocked: 1 workflow(s) awaiting")
    assert "Awaiting maintainer approval for fork PR workflow" in result.summary


def test_a_clean_pr_with_checks_still_running_is_ready_once_ci_passes(review):
    review.gh.answer({CHECKS: checks(("unit", "IN_PROGRESS"), ("lint", "SUCCESS"))})

    result = review.run()

    assert result.verdict is MergeVerdict.READY_TO_MERGE
    assert (
        "> **⏳ Ready once CI passes** - 1 check(s) pending, no blocking code issues."
        in result.summary
    )
    assert "All checks passing" not in result.summary


# ---------------------------------------------------------------------------
# The verdict, its reasoning and its blockers
# ---------------------------------------------------------------------------

LOW = ReviewSeverity.LOW
MEDIUM = ReviewSeverity.MEDIUM
HIGH = ReviewSeverity.HIGH
CRITICAL = ReviewSeverity.CRITICAL

VERDICTS = {
    "merge conflicts": (
        {"context": {"has_merge_conflicts": True}},
        MergeVerdict.BLOCKED,
        "Blocked: PR has merge conflicts with base branch. Resolve conflicts before merge.",
        ["Merge Conflicts: PR has conflicts with base branch that must be resolved"],
        "**🔴 Blocked** - Merge conflicts must be resolved before merge.",
    ),
    "branch behind": (
        {"context": {"merge_state_status": "BEHIND"}},
        MergeVerdict.NEEDS_REVISION,
        BRANCH_BEHIND_REASONING,
        [BRANCH_BEHIND_BLOCKER_MSG],
        "**🟠 Needs revision** - 1 structural/other issue(s) require attention.",
    ),
    "branch behind with findings": (
        {
            "context": {"merge_state_status": "BEHIND"},
            "findings": [
                finding("h", HIGH),
                finding("m", MEDIUM),
                finding("l", LOW),
            ],
        },
        MergeVerdict.NEEDS_REVISION,
        f"{BRANCH_BEHIND_REASONING} 2 issue(s) must be addressed (1 required, 1 "
        "recommended). 1 non-blocking suggestion(s) to consider.",
        [BRANCH_BEHIND_BLOCKER_MSG],
        "**🟠 Needs revision** - 2 issue(s) require attention.",
    ),
    "unverifiable claim": (
        {
            "findings": [
                finding(
                    "v",
                    LOW,
                    ReviewCategory.VERIFICATION_FAILED,
                    "Claims a test exists",
                    verification_note="no such file",
                ),
                finding("w", LOW, ReviewCategory.VERIFICATION_FAILED, "Second claim"),
            ]
        },
        MergeVerdict.BLOCKED,
        "Blocked: Cannot verify 2 claim(s) in PR. Evidence required before merge.",
        [
            "Verification Failed: Claims a test exists (src/cache.py:12) - no such file",
            "Verification Failed: Second claim (src/cache.py:12)",
        ],
        "**🔴 Blocked** - Critical issues must be resolved before merge.",
    ),
    "critical security finding": (
        {
            "findings": [
                finding("s", CRITICAL, ReviewCategory.SECURITY, "SQL injection")
            ]
        },
        MergeVerdict.BLOCKED,
        "Blocked by 1 security vulnerabilities",
        ["Security: SQL injection (src/cache.py:12)"],
        "**🔴 Blocked** - 1 critical/high/medium issue(s) must be fixed.",
    ),
    "redundant implementation": (
        {
            "findings": [
                finding(
                    "r",
                    HIGH,
                    ReviewCategory.REDUNDANCY,
                    "Second LRU",
                    redundant_with="src/lru.py:3",
                ),
                finding("q", CRITICAL, ReviewCategory.REDUNDANCY, "Third LRU"),
                finding("n", MEDIUM, ReviewCategory.REDUNDANCY, "Minor overlap"),
            ]
        },
        MergeVerdict.BLOCKED,
        "Blocked: 2 redundant implementation(s) detected. Remove duplicates before merge.",
        [
            "Redundancy: Second LRU (src/cache.py:12) (duplicates src/lru.py:3)",
            "Redundancy: Third LRU (src/cache.py:12)",
        ],
        "**🔴 Blocked** - 3 critical/high/medium issue(s) must be fixed.",
    ),
    "critical finding": (
        {"findings": [finding("c", CRITICAL, title="Data loss on restart")]},
        MergeVerdict.BLOCKED,
        "Blocked by 1 critical issues",
        ["Critical: Data loss on restart (src/cache.py:12)"],
        "**🔴 Blocked** - 1 critical/high/medium issue(s) must be fixed.",
    ),
    "structural issue": (
        {"structural": [structural(), structural("s2", LOW, title="Long file")]},
        MergeVerdict.NEEDS_REVISION,
        "1 issues must be addressed",
        ["Structure: God object"],
        "**🟠 Needs revision** - 1 structural/other issue(s) require attention.",
    ),
    "critical ai comment": (
        {
            "triages": [
                triage(1, AICommentVerdict.CRITICAL, "x" * 60),
                triage(2, AICommentVerdict.CRITICAL, "Leaks a file handle"),
            ]
        },
        MergeVerdict.NEEDS_REVISION,
        "2 issues must be addressed",
        ["CodeRabbit: " + "x" * 50 + "...", "CodeRabbit: Leaks a file handle"],
        "**🟠 Needs revision** - 2 structural/other issue(s) require attention.",
    ),
    "high, medium and low findings": (
        {"findings": [finding("h", HIGH), finding("m", MEDIUM), finding("l", LOW)]},
        MergeVerdict.NEEDS_REVISION,
        "2 issue(s) must be addressed (1 required, 1 recommended), 1 suggestions",
        [],
        "**🟠 Needs revision** - 2 issue(s) require attention.",
    ),
    "one high finding": (
        {"findings": [finding("h", HIGH)]},
        MergeVerdict.NEEDS_REVISION,
        "1 issue(s) must be addressed (1 required, 0 recommended)",
        [],
        "**🟠 Needs revision** - 1 issue(s) require attention.",
    ),
    "low findings only": (
        {"findings": [finding("l", LOW), finding("k", LOW)]},
        MergeVerdict.READY_TO_MERGE,
        "No blocking issues. 2 non-blocking suggestion(s) to consider",
        [],
        "**✅ Ready to merge** - All checks passing, no blocking issues found.",
    ),
    # A title that merely mentions CI or a merge conflict is still code.
    "structural issue about ci": (
        {"structural": [structural(title="CI config duplicated in three places")]},
        MergeVerdict.NEEDS_REVISION,
        "1 issues must be addressed",
        ["Structure: CI config duplicated in three places"],
        "**🟠 Needs revision** - 1 structural/other issue(s) require attention.",
    ),
    "finding about merge conflicts": (
        {"findings": [finding("c", CRITICAL, title="Merge Conflict markers left")]},
        MergeVerdict.BLOCKED,
        "Blocked by 1 critical issues",
        ["Critical: Merge Conflict markers left (src/cache.py:12)"],
        "**🔴 Blocked** - 1 critical/high/medium issue(s) must be fixed.",
    ),
}


@pytest.mark.parametrize("case", list(VERDICTS), ids=list(VERDICTS))
def test_the_verdict_follows_what_the_review_found(review, case):
    setup, verdict, reasoning, blockers, bottom_line = VERDICTS[case]
    review.context = context(**setup.get("context", {}))
    review.findings = setup.get("findings", [])
    review.structural = setup.get("structural", [])
    review.triages = setup.get("triages", [])

    result = review.run()

    assert result.verdict is verdict
    assert result.verdict_reasoning == reasoning
    assert result.blockers == blockers
    assert f"> {bottom_line}" in result.summary
    expected_status = (
        "approve" if verdict is MergeVerdict.READY_TO_MERGE else ("request_changes")
    )
    assert result.overall_status == expected_status


# ---------------------------------------------------------------------------
# The summary the app shows
# ---------------------------------------------------------------------------


def test_the_summary_counts_findings_structure_and_ai_comments(review):
    review.findings = [
        finding("c", CRITICAL),
        finding("h1", HIGH),
        finding("h2", HIGH),
        finding("l", LOW),
    ]
    review.structural = [structural(f"s{i}", LOW, title=f"Issue {i}") for i in range(7)]
    review.triages = [
        triage(1, AICommentVerdict.CRITICAL, "Unsafe eval"),
        triage(2, AICommentVerdict.IMPORTANT),
        triage(3, AICommentVerdict.IMPORTANT),
    ]

    summary = review.run().summary

    assert "### Merge Verdict: 🔴 BLOCKED" in summary
    assert (
        "### Findings Summary\n- **Critical**: 1 issue(s)\n- **High**: 2 issue(s)\n"
        "- **Low**: 1 issue(s)\n" in summary
    )
    assert "- **Issue 4**: Does too much\n- ... and 2 more" in summary
    assert "- **Issue 5**" not in summary
    assert (
        "### 🤖 AI Tool Comments Review\n- **Critical**: 1 validated issues\n"
        "- **Important**: 2 recommended fixes" in summary
    )


def test_only_critical_ai_comments_are_listed_alone(review):
    review.triages = [triage(1, AICommentVerdict.CRITICAL, "Unsafe eval")]

    summary = review.run().summary

    assert "- **Critical**: 1 validated issues\n\n---" in summary
    assert "recommended fixes" not in summary


def test_only_important_ai_comments_are_listed_alone(review):
    review.triages = [triage(1, AICommentVerdict.IMPORTANT)]

    summary = review.run().summary

    assert "### 🤖 AI Tool Comments Review\n- **Important**: 1 recommended fixes" in (
        summary
    )
    assert "validated issues" not in summary


def test_minor_ai_comments_get_no_section(review):
    review.triages = [triage(1, AICommentVerdict.NICE_TO_HAVE)]

    summary = review.run().summary

    assert "AI Tool Comments Review" not in summary
    assert "Findings Summary" not in summary


@pytest.mark.parametrize(
    ("changes", "complexity"), [((400, 101), "high"), ((150, 51), "medium")]
)
def test_the_risk_grows_with_the_size_of_the_change(review, changes, complexity):
    review.context = context(total_additions=changes[0], total_deletions=changes[1])

    result = review.run()

    assert result.risk_assessment["complexity"] == complexity
    assert f"| Complexity | {complexity.capitalize()} |" in result.summary


@pytest.mark.parametrize(
    ("severities", "impact"),
    [((CRITICAL,), "critical"), ((HIGH, LOW), "medium"), ((LOW,), "low")],
)
def test_the_security_impact_follows_the_worst_security_finding(
    review, severities, impact
):
    review.findings = [
        finding(f"s{i}", severity, ReviewCategory.SECURITY)
        for i, severity in enumerate(severities)
    ]

    assert review.run().risk_assessment["security_impact"] == impact


@pytest.mark.parametrize(
    ("issues", "coherence"),
    [
        ([structural("a", HIGH, "feature_creep")], "poor"),
        ([structural("a", LOW, "scope_creep")], "mixed"),
    ],
)
def test_scope_creep_lowers_the_scope_coherence(review, issues, coherence):
    review.structural = issues

    assert review.run().risk_assessment["scope_coherence"] == coherence
