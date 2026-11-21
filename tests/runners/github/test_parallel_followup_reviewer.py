"""The parallel follow-up review: an orchestrator session and its specialists.

`ParallelFollowupReviewer.review` (runners/github/services/parallel_followup_reviewer.py)
re-reviews a PR after new commits. It checks the PR's head out in a worktree
of the project, starts one orchestrator session that may delegate to the
resolution-verifier, new-code-reviewer, comment-analyzer and finding-validator
sub-agents, and reads its structured answer (`ParallelFollowupResponse`): which
earlier findings were fixed, which a validator dismissed as false positives,
what is new. Then the verdict is held to the PR's state: merge conflicts block,
a branch behind its base or pending CI cannot be ready to merge, failing CI
blocks. The summary posted to the PR says all of it in one line first.

Real here: git (a repository with a local origin, `tests/pr_repo.py`), the
worktree, the prompts and sub-agent roster, the parsing. Stand-ins: the model
(`tests/review_llm_fake.py`, provider-neutral messages) and `gh`
(`tests/gh_fake.py`, which serves the PR files the blob SHAs come from).
"""

from __future__ import annotations

import asyncio
import importlib
import json
import sys

import pytest
from integrations.jev.models import JevAnswer, JevOutcome
from runners.github.models import (
    FollowupReviewContext,
    GitHubRunnerConfig,
    MergeVerdict,
    PRReviewFinding,
    PRReviewResult,
    ReviewCategory,
    ReviewSeverity,
)
from runners.github.orchestrator import ProgressCallback
from runners.github.services.parallel_followup_reviewer import (
    ParallelFollowupReviewer,
)

from tests.pr_repo import git, make_repo
from tests.review_llm_fake import StandInModel, structured, text, tool_use

reviewer_module = importlib.import_module(
    "runners.github.services.parallel_followup_reviewer"
)

FILES_ENDPOINT = (
    "api --method GET repos/{owner}/{repo}/pulls/9/files -f page=1 -f per_page=100"
)
EXPLANATION = "The finding claimed X; the code shows Y, so it is not real."


def verification() -> dict:
    return {
        "code_examined": "token = load()",
        "line_range_examined": [1, 2],
        "verification_method": "direct_code_inspection",
    }


def new_finding(fid: str, severity="medium", **extra) -> dict:
    return {
        "id": fid,
        "file": "app.py",
        "line": 2,
        "title": f"New {fid}",
        "description": "Found in the new commits.",
        "category": "logic",
        "severity": severity,
        "verification": verification(),
        "source_agent": "new-code-reviewer",
        **extra,
    }


def validation(fid: str, status: str) -> dict:
    return {
        "finding_id": fid,
        "validation_status": status,
        "code_evidence": "token = load()",
        "line_range": [1, 1],
        "explanation": EXPLANATION,
        "evidence_verified_in_file": True,
    }


def response(**overrides) -> dict:
    data = {
        "analysis_summary": "Checked the fixes.",
        "agents_invoked": ["resolution-verifier", "new-code-reviewer"],
        "resolution_verifications": [
            {"finding_id": "f1", "status": "resolved", "evidence": "fixed"},
            {"finding_id": "f2", "status": "unresolved", "evidence": "still there"},
            {"finding_id": "f3", "status": "unresolved", "evidence": "x"},
            {"finding_id": "f4", "status": "cant_verify", "evidence": "x"},
            {"finding_id": "f5", "status": "unresolved", "evidence": "x"},
            {"finding_id": "gone", "status": "partially_resolved", "evidence": "x"},
            {"finding_id": "ghost", "status": "cant_verify", "evidence": "x"},
        ],
        "finding_validations": [
            validation("f2", "confirmed_valid"),
            validation("f3", "dismissed_false_positive"),
            validation("f4", "needs_human_review"),
        ],
        "new_findings": [
            new_finding("n1", "low"),
            new_finding("n1", "low"),
            new_finding("", "high"),
        ],
        "comment_findings": [
            new_finding("c1", "low", category="docs", source_agent="comment-analyzer")
        ],
        "verdict": "NEEDS_REVISION",
        "verdict_reasoning": "One finding is still open.",
    }
    data.update(overrides)
    return data


def old(fid: str, severity=ReviewSeverity.MEDIUM) -> PRReviewFinding:
    return PRReviewFinding(
        id=fid,
        severity=severity,
        category=ReviewCategory.QUALITY,
        title=f"Old {fid}",
        description="From the first review. " * 20,
        file="app.py",
        line=1,
        suggested_fix="Do it right.",
    )


def context(head: str, **overrides) -> FollowupReviewContext:
    values = {
        "pr_number": 9,
        "previous_review": PRReviewResult(
            pr_number=9,
            repo="own/repo",
            success=True,
            findings=[old(f"f{n}") for n in range(1, 6)],
            summary="Five issues.",
        ),
        "previous_commit_sha": "aaaaaaaa1111",
        "current_commit_sha": head,
        "commits_since_review": [
            {
                "sha": "cafef00d99",
                "commit": {"message": "Fix it\n\nbody", "author": {"name": "Ann"}},
            }
        ],
        "files_changed_since_review": ["app.py"],
        "diff_since_review": "@@ -1 +1 @@\n-token = old()\n+token = load()\n",
        "contributor_comments_since_review": [
            {"user": {"login": "ann"}, "body": "Is this safe?"}
        ],
        "ai_bot_comments_since_review": [
            {"user": {"login": "coderabbitai"}, "body": "Nit."}
        ],
        "pr_reviews_since_review": [
            {"user": {"login": "gemini"}, "body": "Looks fine.", "state": "COMMENTED"}
        ],
    }
    values.update(overrides)
    return FollowupReviewContext(**values)


@pytest.fixture
def project(tmp_path, monkeypatch):
    return make_repo(tmp_path, monkeypatch, {"app.py": "token = load()\nuse(token)\n"})


@pytest.fixture
def head(project):
    return git(project, "rev-parse", "HEAD")


@pytest.fixture
def model(monkeypatch):
    stand_in = StandInModel()
    monkeypatch.setattr(reviewer_module, "create_agent_client", stand_in.agent)
    return stand_in


@pytest.fixture
def blobs(gh):
    gh.answer(
        {
            FILES_ENDPOINT: {
                "stdout": json.dumps(
                    [
                        {"filename": "app.py", "sha": "b10b"},
                        {"filename": "README.md"},
                    ]
                )
            }
        }
    )
    return gh


@pytest.fixture
def events():
    return []


@pytest.fixture
def reviewer(project, events):
    return ParallelFollowupReviewer(
        project,
        project / ".workpilot" / "github",
        GitHubRunnerConfig(
            token="placeholder",  # pragma: allowlist secret
            repo="own/repo",
        ),
        progress_callback=events.append,
    )


def review(reviewer, ctx) -> PRReviewResult:
    return asyncio.run(reviewer.review(ctx))


class TestTheReview:
    def test_the_orchestrator_s_answer_is_the_follow_up_review(
        self, reviewer, model, blobs, head, project, events, capsys
    ):
        model.answer(
            tool_use("Task", {"subagent_type": "resolution-verifier"}, "t1"),
            structured(response()),
        )

        result = review(reviewer, context(head))

        assert result.success and result.is_followup_review
        assert result.resolved_findings == ["f1", "f3"]
        assert result.unresolved_findings == ["f2", "f4", "f5", "gone", "ghost"]
        by_id = {f.id: f for f in result.findings}
        assert by_id["f2"].title == "[UNRESOLVED] Old f2"
        assert by_id["f2"].validation_status == "confirmed_valid"
        assert by_id["f4"].validation_status == "needs_human_review"
        assert by_id["f5"].validation_status is None
        assert "gone" not in by_id and "ghost" not in by_id
        assert [f.id for f in result.findings].count("n1") == 1
        generated = [fid for fid in by_id if fid.startswith("FU-")]
        assert len(generated) == 1
        assert by_id["c1"].title == "[FROM COMMENTS] New c1"
        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert result.overall_status == "request_changes"
        assert result.reviewed_file_blobs == {"app.py": "b10b"}
        assert result.reviewed_commit_sha == head
        assert result.previous_review_id == 9
        assert "quality: [UNRESOLVED] Old f2" in result.blockers
        assert "logic: New n1" not in result.blockers
        assert "### Finding Validation" in result.summary
        assert (
            "Agents invoked: resolution-verifier, new-code-reviewer" in result.summary
        )
        assert "5 unresolved finding(s) from previous review" in result.summary
        [session] = model.clients
        assert session.options["agent_type"] == "pr_followup_parallel"
        worktree = session.options["project_dir"]
        assert worktree != project and worktree.name.startswith("pr-9-")
        assert not worktree.exists(), "the worktree is removed after the review"
        assert "finding-validator" in session.options["agents"]
        assert str(worktree) in session.options["agents"]["finding-validator"].prompt
        assert [(e.phase, e.progress) for e in events] == [
            ("orchestrating", 35),
            ("orchestrating", 40),
            ("finalizing", 50),
            ("analyzed", 60),
        ]
        assert all(isinstance(e, ProgressCallback) for e in events)
        printed = capsys.readouterr().out
        assert "[VALIDATED]" in printed and "[NEEDS HUMAN REVIEW]" in printed
        assert "DISMISSED as false positive" in printed

    def test_the_prompt_carries_the_follow_up_context(self, reviewer, model, gh, head):
        model.answer(structured(response()))
        ctx = context(
            head,
            diff_since_review="+x\n" * 40_000,
            ci_status={"passing": 3},
            jev_outcome=JevOutcome(
                status="evaluated", answers={"risk": JevAnswer("choice", "high", 0.7)}
            ),
            previous_review=PRReviewResult(9, "own/repo", True, summary=""),
        )

        review(reviewer, ctx)

        prompt = model.prompts[0]
        assert "**Previous Review Commit:** aaaaaaaa" in prompt
        assert "No previous findings to verify." in prompt
        assert "No summary available." in prompt
        assert "- `cafef00` by Ann: Fix it" in prompt
        assert "**@ann**: Is this safe?" in prompt
        assert "**coderabbitai** (comment):\nNit." in prompt
        assert "**gemini** (COMMENTED):\nLooks fine." in prompt
        assert "✅ **All 3 CI check(s) passing**" in prompt
        assert "... (diff truncated)" in prompt
        assert "Optional JEV assessment" in prompt

    def test_an_empty_follow_up_says_so(self, reviewer, model, gh, head):
        model.answer(structured(response()))
        ctx = context(
            head,
            commits_since_review=[],
            contributor_comments_since_review=[],
            ai_bot_comments_since_review=[],
            pr_reviews_since_review=[],
        )

        review(reviewer, ctx)

        prompt = model.prompts[0]
        assert "No new commits." in prompt
        assert "No contributor comments since last review." in prompt
        assert "No AI tool feedback since last review." in prompt
        assert "CI status not available." in prompt

    def test_without_structured_output_the_text_gives_the_verdict(
        self, reviewer, model, gh, head
    ):
        model.answer(
            tool_use("Task", {"subagent_type": "new-code-reviewer"}, "t1"),
            text("All fixed, ready to merge."),
        )

        result = review(reviewer, context(head))

        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert result.verdict_reasoning == "All fixed, ready to merge."
        assert "Agents invoked: new-code-reviewer" in result.summary

    def test_a_broken_session_is_a_failed_review(self, reviewer, model, gh, head):
        model.answer(text("partial"), ConnectionError("provider went away"))

        result = review(reviewer, context(head))

        assert not result.success
        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert "provider went away" in result.summary
        assert result.reviewed_commit_sha == head


class TestThePrStateHoldsTheVerdict:
    @pytest.fixture
    def ready(self, model):
        model.answer(
            structured(
                response(
                    resolution_verifications=[],
                    finding_validations=[],
                    new_findings=[],
                    comment_findings=[],
                    agents_invoked=[],
                    verdict="READY_TO_MERGE",
                    verdict_reasoning="Clean.",
                )
            )
        )

    def test_a_clean_follow_up_is_ready_to_merge(self, reviewer, gh, head, ready):
        result = review(reviewer, context(head))

        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert result.overall_status == "approve"
        assert "**✅ Ready to merge**" in result.summary
        assert "Agents invoked: orchestrator only" in result.summary

    def test_merge_conflicts_block(self, reviewer, gh, head, ready):
        result = review(reviewer, context(head, has_merge_conflicts=True))

        assert result.verdict == MergeVerdict.BLOCKED
        assert result.blockers[0].startswith("Merge Conflicts")
        assert "Merge conflicts must be resolved" in result.summary

    def test_a_branch_behind_its_base_needs_an_update(self, reviewer, gh, head, ready):
        result = review(reviewer, context(head, merge_state_status="BEHIND"))

        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert result.overall_status == "request_changes"

    @pytest.mark.parametrize(
        ("checks", "shown"),
        [(["lint", "test", "build", "e2e"], "lint, test, build"), ([], "unknown")],
    )
    def test_failing_ci_blocks(self, reviewer, gh, head, ready, checks, shown):
        ci = {"failing": 2, "failed_checks": checks}

        result = review(reviewer, context(head, ci_status=ci))

        assert result.verdict == MergeVerdict.BLOCKED
        assert f"CI Failing: 2 check(s) failing ({shown})" in result.blockers
        assert "2 CI check(s) failing. Fix CI before merge." in result.summary

    def test_pending_ci_is_ready_once_it_passes(self, reviewer, gh, head, ready):
        result = review(reviewer, context(head, ci_status={"pending": 2}))

        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert "Ready once CI passes" in result.verdict_reasoning
        assert "**⏳ Ready once CI passes** - 2 check(s) pending" in result.summary

    @pytest.mark.parametrize(
        ("verdict", "ci", "state", "line"),
        [
            ("BLOCKED", {"failing": 1}, "", "1 CI check(s) failing"),
            ("NEEDS_REVISION", {"failing": 1}, "", "See details below"),
            ("BLOCKED", {"pending": 1}, "", "Critical issues must be resolved"),
            ("BLOCKED", {}, "BEHIND", "1 blocking issue(s) require fixes"),
            ("MERGE_WITH_CHANGES", {}, "", "**🟡 Can merge** - Minor"),
            ("BLOCKED", {"awaiting_approval": 1}, "", "Awaiting maintainer approval"),
        ],
    )
    def test_a_verdict_the_pr_state_does_not_change_is_kept(
        self, reviewer, model, gh, head, verdict, ci, state, line
    ):
        model.answer(
            structured(
                response(
                    resolution_verifications=[],
                    finding_validations=[],
                    new_findings=[],
                    comment_findings=[],
                    verdict=verdict,
                )
            )
        )

        result = review(reviewer, context(head, ci_status=ci, merge_state_status=state))

        assert result.verdict == MergeVerdict[verdict]
        assert line in result.summary

    def test_a_merge_with_changes_verdict_comments(self, reviewer, model, gh, head):
        model.answer(
            structured(
                response(
                    resolution_verifications=[],
                    finding_validations=[],
                    new_findings=[new_finding("n1", "low")],
                    comment_findings=[],
                    verdict="MERGE_WITH_CHANGES",
                )
            )
        )

        result = review(reviewer, context(head))

        assert result.overall_status == "comment"


class TestWhereTheReviewReads:
    @pytest.mark.parametrize("debug", [False, True])
    def test_a_head_commit_the_repository_lacks_falls_back_to_the_checkout(
        self, reviewer, model, gh, project, monkeypatch, debug
    ):
        monkeypatch.setattr(reviewer_module, "DEBUG_MODE", debug)
        model.answer(structured(response()))

        result = review(reviewer, context("0123456789abcdef0123456789abcdef01234567"))

        assert result.success
        assert model.clients[0].options["project_dir"] == project

    def test_a_worktree_is_never_made_for_an_unsafe_ref(self, reviewer):
        with pytest.raises(ValueError, match="Invalid git ref"):
            reviewer._create_pr_worktree("main; rm -rf /", 9)

    def test_an_unsafe_head_ref_is_never_checked_out(
        self, reviewer, model, gh, project
    ):
        model.answer(structured(response()))

        result = review(reviewer, context("main; rm -rf /"))

        assert result.success
        assert model.clients[0].options["project_dir"] == project

    def test_with_debug_on_the_worktree_is_announced(
        self, reviewer, model, gh, head, monkeypatch, capsys
    ):
        monkeypatch.setattr(reviewer_module, "DEBUG_MODE", True)
        model.answer(structured(response()))

        review(reviewer, context(head))

        assert "DEBUG: Creating worktree" in capsys.readouterr().out

    def test_a_project_folder_named_backend_is_read_as_it_is(self, tmp_path, model, gh):
        backend = tmp_path / "apps" / "backend"
        backend.mkdir(parents=True)
        reviewer = ParallelFollowupReviewer(
            backend,
            tmp_path / "gh",
            GitHubRunnerConfig(
                token="placeholder",  # pragma: allowlist secret
                repo="o/r",
                model="",
                thinking_level="",
            ),
        )
        model.answer(structured(response()))

        review(reviewer, context(""))

        assert model.clients[0].options["project_dir"] == backend

    def test_progress_goes_through_the_runner_s_orchestrator_when_it_has_one(
        self, reviewer, model, gh, head, events, monkeypatch
    ):
        runner_copy = importlib.import_module("runners.github.orchestrator")
        monkeypatch.setitem(sys.modules, "orchestrator", runner_copy)
        model.answer(structured(response()))

        review(reviewer, context(head))

        assert events and all(
            isinstance(e, runner_copy.ProgressCallback) for e in events
        )

    def test_missing_prompts_fall_back_to_a_built_in_instruction(
        self, reviewer, model, gh, head, tmp_path
    ):
        reviewer.prompts_dir = tmp_path / "no-prompts"
        model.answer(structured(response()))

        review(reviewer, context(head))

        assert model.prompts[0].startswith("You are a follow-up PR reviewer.")


class TestAnswersThatDoNotFitTheSchema:
    def test_a_partial_answer_keeps_what_it_can(self, reviewer, model, gh, head):
        model.answer(
            structured(
                {
                    "resolution_verifications": [
                        {"finding_id": "f1", "status": "resolved"},
                        {"finding_id": "f2", "status": "cant_verify"},
                        {"finding_id": "f3", "status": "weird"},
                        {"finding_id": "", "status": "resolved"},
                        "not a dict",
                    ],
                    "new_findings": [{"id": "n9"}, {"id": ""}, "x"],
                    "verdict": "BLOCKED",
                    "agents_invoked": ["comment-analyzer"],
                }
            )
        )

        result = review(reviewer, context(head))

        assert result.resolved_findings == ["f1"]
        assert result.unresolved_findings == ["f2"]
        assert result.new_findings_since_last_review == ["n9"]
        assert result.verdict == MergeVerdict.BLOCKED
        assert result.verdict_reasoning.startswith("[Partial extraction]")

    @pytest.mark.parametrize(
        "data",
        [
            {"resolution_verifications": "no", "new_findings": "no"},
            {"verdict": ["not", "hashable"], "new_findings": [{"id": "n"}]},
        ],
        ids=["nothing-to-keep", "unreadable"],
    )
    def test_an_answer_with_nothing_usable_is_an_empty_review(
        self, reviewer, model, gh, head, data
    ):
        model.answer(structured(data))

        result = review(reviewer, context(head))

        assert result.findings == []
        assert result.verdict_reasoning == "Unable to parse review results"

    def test_an_answer_that_is_not_an_object_is_an_empty_review(self, reviewer, head):
        assert reviewer._extract_partial_data(["a", "list"]) is None

    @pytest.mark.parametrize(
        ("answer", "verdict"),
        [
            ("This looks good, approve.", MergeVerdict.READY_TO_MERGE),
            ("Blocked by a critical bug.", MergeVerdict.BLOCKED),
            ("Needs revision before merge.", MergeVerdict.NEEDS_REVISION),
            ("Some notes.", MergeVerdict.MERGE_WITH_CHANGES),
            ("", MergeVerdict.MERGE_WITH_CHANGES),
        ],
    )
    def test_a_text_answer_is_read_for_its_verdict(
        self, reviewer, head, answer, verdict
    ):
        parsed = reviewer._parse_text_output(answer, context(head))

        assert parsed["verdict"] == verdict
        assert parsed["verdict_reasoning"] == (answer or "Unable to parse response")


class TestTheSummaryLine:
    @pytest.mark.parametrize(
        ("verdict", "ci", "unresolved", "new", "blockers", "line"),
        [
            (MergeVerdict.BLOCKED, {}, 0, 0, ["security: Leak"], "1 blocking issue(s)"),
            (
                MergeVerdict.NEEDS_REVISION,
                {},
                0,
                0,
                ["logic: Bug"],
                "1 blocking issue(s)",
            ),
            (MergeVerdict.NEEDS_REVISION, {}, 0, 2, [], "2 new issue(s)"),
            (
                MergeVerdict.MERGE_WITH_CHANGES,
                {"pending": 1},
                0,
                0,
                [],
                "once CI passes",
            ),
        ],
    )
    def test_the_first_line_says_what_stands_in_the_way(
        self, reviewer, verdict, ci, unresolved, new, blockers, line
    ):
        assert line in reviewer._generate_bottom_line(
            verdict, ci, unresolved, new, blockers
        )

    @pytest.mark.parametrize(
        ("ci", "lines"),
        [
            (
                {"failing": 1, "failed_checks": ["lint"]},
                ["1 CI check(s) FAILING", "❌ lint"],
            ),
            ({"pending": 1}, ["1 CI check(s) pending"]),
            (
                {"awaiting_approval": 1},
                ["No CI checks configured", "awaiting maintainer"],
            ),
        ],
    )
    def test_the_ci_status_is_written_for_the_orchestrator(
        self, reviewer, head, ci, lines
    ):
        written = reviewer._format_ci_status(context(head, ci_status=ci))

        assert all(line in written for line in lines)

    def test_without_a_progress_callback_nothing_is_reported(self, reviewer):
        reviewer.progress_callback = None

        reviewer._report_progress("orchestrating", 1, "quiet")
