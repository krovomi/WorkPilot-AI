"""The follow-up review: what changed on a PR since WorkPilot last reviewed it.

`FollowupReviewer.review_followup` (runners/github/services/followup_reviewer.py)
takes the previous review and the commits, diff and comments since, and says
which earlier findings were fixed, what is new, and whether the PR can merge.
Without a model (or for a small diff) it reads the diff itself: a finding whose
line sits in a changed hunk is resolved, added lines with a hard-coded secret
or an `eval(` are new findings, a contributor's question is a finding to
answer. With a model, a structured answer (`FollowupReviewResponse`) decides
which findings are resolved and what is new.

The model is the Claude SDK client of `tests/review_llm_fake.py`, streaming the
SDK's real message classes; `gh` is the fake of `tests/gh_fake.py`, which
answers the PR files endpoint the review reads blob SHAs from.
"""

from __future__ import annotations

import asyncio
import importlib
import json

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock, ToolUseBlock
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
from runners.github.services.followup_reviewer import FollowupReviewer

from tests.review_llm_fake import StandInModel

FILES_ENDPOINT = (
    "api --method GET repos/{owner}/{repo}/pulls/9/files -f page=1 -f per_page=100"
)

DIFF = """--- a/app.py
+++ b/app.py
@@ -10,3 +10,4 @@ def handler():
-    token = load()
+    token = load_token()
+    password = "hunter22"
--- a/web.js
+++ b/web.js
@@ -40 +40 @@
+    el.innerHTML = x; eval(input)
"""


def old_finding(fid, file="app.py", line=11, severity=ReviewSeverity.HIGH):
    return PRReviewFinding(
        id=fid,
        severity=severity,
        category=ReviewCategory.SECURITY,
        title=f"Finding {fid}",
        description="From the first review.",
        file=file,
        line=line,
    )


def context(*findings, diff=DIFF, **overrides) -> FollowupReviewContext:
    values = {
        "pr_number": 9,
        "previous_review": PRReviewResult(
            pr_number=9,
            repo="own/repo",
            success=True,
            findings=list(findings),
            summary="Two issues.",
            review_id=77,
        ),
        "previous_commit_sha": "aaaaaaaa11112222",
        "current_commit_sha": "bbbbbbbb33334444",
        "commits_since_review": [
            {
                "sha": "cafef00d99",
                "commit": {
                    "message": "Load the token\n\nbody",
                    "author": {"date": "2026-11-03"},
                },
            }
        ],
        "files_changed_since_review": ["app.py", "web.js"],
        "diff_since_review": diff,
    }
    values.update(overrides)
    return FollowupReviewContext(**values)


@pytest.fixture
def blobs(gh):
    gh.answer(
        {
            FILES_ENDPOINT: {
                "stdout": json.dumps(
                    [
                        {"filename": "app.py", "sha": "b10b"},
                        {"filename": "web.js", "sha": ""},
                    ]
                )
            }
        }
    )
    return gh


@pytest.fixture
def events():
    return []


def reviewer(tmp_path, events, use_ai=False, **config):
    return FollowupReviewer(
        tmp_path,
        tmp_path / ".workpilot" / "github",
        GitHubRunnerConfig(
            token="placeholder",  # pragma: allowlist secret
            repo="own/repo",
            **config,
        ),
        progress_callback=events.append,
        use_ai=use_ai,
    )


@pytest.fixture
def model(monkeypatch):
    stand_in = StandInModel()
    monkeypatch.setattr(
        importlib.import_module("core.simple_client"),
        "create_simple_client",
        stand_in.sdk,
    )
    return stand_in


def verification() -> dict:
    return {
        "code_examined": "password = 'x'",
        "line_range_examined": [1, 2],
        "verification_method": "direct_code_inspection",
    }


def answer(**overrides) -> dict:
    data = {
        "finding_resolutions": [
            {"finding_id": "f1", "status": "resolved", "resolution_notes": "fixed"},
            {"finding_id": "f2", "status": "unresolved"},
        ],
        "new_findings": [
            {
                "id": "n1",
                "severity": "low",
                "category": "quality",
                "title": "Name it",
                "description": "Rename.",
                "file": "app.py",
                "line": 3,
                "verification": verification(),
            }
        ],
        "comment_findings": [
            {
                "id": "c1",
                "severity": "low",
                "category": "docs",
                "title": "Answer Ann",
                "description": "She asked.",
                "file": "",
                "verification": verification(),
            }
        ],
        "verdict": "READY_TO_MERGE",
        "verdict_reasoning": "Good.",
    }
    data.update(overrides)
    return data


def said(*blocks) -> AssistantMessage:
    return AssistantMessage(content=list(blocks), model="claude-sonnet-4-5")


def finished(subtype="success", **extra) -> ResultMessage:
    return ResultMessage(
        subtype=subtype,
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        **extra,
    )


class TestWithoutAModel:
    def test_a_finding_on_a_changed_line_is_resolved_and_new_risks_are_found(
        self, tmp_path, events, blobs
    ):
        fixed = old_finding("f1", line=11)
        elsewhere = old_finding("f2", file="other.py", severity=ReviewSeverity.LOW)
        untouched = old_finding("f3", line=200, severity=ReviewSeverity.MEDIUM)
        comments = [
            {"id": 1, "body": "ok", "user": {"login": "bo"}},
            {
                "id": 2,
                "body": "Why not use the existing loader here instead of this?",
                "user": {"login": "ann"},
                "path": "app.py",
                "line": 12,
            },
            {
                "id": 3,
                "body": "This is a real concern " + "x" * 120,
                "author": {"login": "cy"},
            },
            {"id": 4, "body": "I really like the new structure here."},
            {"id": 5, "body": "Is a test planned for this case?", "line": None},
        ]

        result = asyncio.run(
            reviewer(tmp_path, events).review_followup(
                context(
                    fixed,
                    elsewhere,
                    untouched,
                    contributor_comments_since_review=comments,
                )
            )
        )

        assert result.success and result.is_followup_review
        assert result.resolved_findings == ["f1"]
        assert result.unresolved_findings == ["f2", "f3"]
        titles = [f.title for f in result.findings]
        assert titles[:2] == ["Finding f2", "Finding f3"]
        assert "Hardcoded password detected" in titles
        assert "Use of eval() detected" in titles
        answers = [f for f in result.findings if f.title.startswith("Contributor")]
        assert [f.description.split(":")[0] for f in answers] == [
            "Comment from ann",
            "Comment from cy",
            "Comment from ",
        ]
        assert answers[1].description.endswith("...")
        assert answers[0].file == "app.py" and answers[0].line == 12
        assert answers[2].line == 0
        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert result.overall_status == "request_changes"
        assert result.reviewed_file_blobs == {"app.py": "b10b"}
        assert result.previous_review_id == 77
        assert result.reviewed_commit_sha == "bbbbbbbb33334444"
        assert [e["progress"] for e in events] == [20, 40, 60, 80, 100]
        assert "Reviewed 1 new commit(s)" in result.summary

    def test_a_critical_finding_left_open_blocks_the_merge(self, tmp_path, events, gh):
        critical = old_finding("f1", file="db.py", severity=ReviewSeverity.CRITICAL)

        result = asyncio.run(
            reviewer(tmp_path, events).review_followup(context(critical, diff=""))
        )

        assert result.verdict == MergeVerdict.BLOCKED
        assert result.overall_status == "request_changes"
        assert result.blockers == ["Unresolved: Finding f1 (db.py:11)"]
        assert "Still blocked by 1 critical issues" in result.verdict_reasoning
        assert result.reviewed_file_blobs == {}

    def test_only_low_suggestions_left_is_ready_to_merge(self, tmp_path, events, gh):
        low = old_finding("f1", file="docs.md", severity=ReviewSeverity.LOW)

        result = asyncio.run(
            reviewer(tmp_path, events).review_followup(context(low, diff=""))
        )

        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert result.overall_status == "approve"
        assert "1 non-blocking suggestion(s)" in result.verdict_reasoning
        assert ":rocket: Ready to Merge" in result.summary

    def test_everything_addressed_is_ready_to_merge(self, tmp_path, events, gh):
        result = asyncio.run(
            reviewer(tmp_path, events).review_followup(
                context(old_finding("f1"), diff="--- a/app.py\n@@ -11 +11 @@\n+ok\n")
            )
        )

        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert "All 1 previous findings have been addressed" in result.verdict_reasoning

    def test_a_new_critical_issue_blocks_too(self, tmp_path):
        fu = reviewer(tmp_path, [])
        new = [old_finding("n", severity=ReviewSeverity.CRITICAL)]

        verdict, _reason, blockers = fu._generate_followup_verdict(0, [], new)

        assert verdict == MergeVerdict.BLOCKED
        assert blockers == ["New issue: Finding n"]

    @pytest.mark.parametrize(
        ("line", "diff", "changed"),
        [
            (5, "", False),
            (None, "--- a/app.py\n", True),
            (0, "--- a/app.py\n", True),
            (5, "--- a/other.py\n@@ -5 +5 @@\n", False),
            (5, "--- a/app.py\n@@ -1,2 +1,2 @@\n--- a/b.py\n@@ -5 +5 @@\n", False),
            (5, "--- a/app.py\n@@ -4 +4 @@\n", True),
            (5, "--- a/app.py\n@@ -1,2 +3,9 @@\n", True),
        ],
    )
    def test_a_line_is_changed_when_a_hunk_of_its_file_covers_it(
        self, tmp_path, line, diff, changed
    ):
        fu = reviewer(tmp_path, [])

        assert fu._line_appears_changed("app.py", line, diff) is changed

    def test_a_secret_in_a_removed_line_is_not_a_new_finding(self, tmp_path):
        fu = reviewer(tmp_path, [])
        diff = "-" + "a" * 60 + ' api_key = "abc"' + "b" * 60

        assert fu._check_new_changes_heuristic(diff, ["app.py"]) == []
        assert fu._check_new_changes_heuristic("", []) == []

    def test_without_a_progress_callback_the_review_still_runs(self, tmp_path, gh):
        fu = reviewer(tmp_path, [])
        fu.progress_callback = None

        result = asyncio.run(fu.review_followup(context(diff="")))

        assert result.success


class TestWithAModel:
    def test_the_model_s_resolutions_and_findings_are_the_review(
        self, tmp_path, events, model, blobs
    ):
        model.answer(
            said(TextBlock(text="Checking.")),
            said(ToolUseBlock(id="r", name="Read", input={})),
            said(ToolUseBlock(id="s0", name="StructuredOutput", input={})),
            said(ToolUseBlock(id="s1", name="StructuredOutput", input=answer())),
        )
        reviews = [
            {"user": {"login": "coderabbitai"}, "state": "COMMENTED", "body": "Nit."},
            {"user": {"login": "bot"}, "body": "   "},
        ]

        result = asyncio.run(
            reviewer(
                tmp_path, events, use_ai=True, model="", thinking_level=""
            ).review_followup(
                context(
                    old_finding("f1", line=500),
                    old_finding("f2", severity=ReviewSeverity.LOW),
                    old_finding("f3", severity=ReviewSeverity.LOW),
                    diff=DIFF + "x" * 15_100,
                    contributor_comments_since_review=[
                        {"user": {"login": "ann"}, "created_at": "t", "body": "Why?"}
                    ],
                    ai_bot_comments_since_review=[
                        {"user": {"login": "cursor"}, "body": "Hm."}
                    ],
                    pr_reviews_since_review=reviews,
                )
            )
        )

        assert result.resolved_findings == ["f1"]
        assert result.unresolved_findings == ["f2", "f3"]
        assert [f.id for f in result.findings] == ["f2", "f3", "n1", "c1"]
        assert result.findings[2].severity == ReviewSeverity.LOW
        assert result.verdict == MergeVerdict.READY_TO_MERGE
        [session] = model.clients
        assert session.options["agent_type"] == "pr_followup_reviewer"
        assert session.options["output_format"]["type"] == "json_schema"
        assert session.options["model"].startswith("claude-")
        prompt = session.prompt
        assert "- [f1] HIGH: Finding f1 (app.py:500)" in prompt
        assert "- cafef00d (2026-11-03): Load the token" in prompt
        assert "- @ann (t): Why?" in prompt and "- @cursor (unknown): Hm." in prompt
        assert "**@coderabbitai** (COMMENTED):\nNit." in prompt
        assert "**@bot**" not in prompt
        assert "(truncated, " in prompt

    def test_an_empty_context_says_so_in_the_prompt(self, tmp_path, events, model, gh):
        model.answer(finished(structured_output=answer(finding_resolutions=[])))

        result = asyncio.run(
            reviewer(tmp_path, events, use_ai=True).review_followup(
                context(
                    diff="+" + "y" * 200,
                    commits_since_review=[],
                    files_changed_since_review=[],
                    jev_outcome=JevOutcome(
                        status="evaluated",
                        answers={"risk": JevAnswer("choice", "low", 0.8)},
                    ),
                )
            )
        )

        prompt = model.clients[0].prompt
        for empty in (
            "No previous findings.",
            "No new commits.",
            "No files changed.",
            "No contributor comments.",
            "No AI bot comments.",
            "No PR reviews since last review.",
        ):
            assert empty in prompt
        assert "Optional JEV assessment" in prompt
        assert [f.id for f in result.findings] == ["n1", "c1"]

    def test_a_model_that_cannot_answer_in_the_schema_leaves_the_heuristic(
        self, tmp_path, events, model, gh
    ):
        model.answer(finished("error_max_structured_output_retries"))

        result = asyncio.run(
            reviewer(tmp_path, events, use_ai=True).review_followup(
                context(old_finding("f1"))
            )
        )

        assert result.resolved_findings == ["f1"]
        assert "Hardcoded password detected" in [f.title for f in result.findings]

    @pytest.mark.parametrize(
        "messages",
        [
            [said(TextBlock(text="no schema")), finished()],
            [ConnectionError("stream lost")],
            [said(ToolUseBlock(id="s", name="StructuredOutput", input={"verdict": 1}))],
        ],
        ids=["no-output", "broken-stream", "invalid-output"],
    )
    def test_without_a_usable_answer_the_review_reads_the_diff_itself(
        self, tmp_path, events, model, gh, messages
    ):
        model.answer(*messages)

        result = asyncio.run(
            reviewer(tmp_path, events, use_ai=True).review_followup(context())
        )

        assert "Use of eval() detected" in [f.title for f in result.findings]

    def test_a_client_that_cannot_start_leaves_the_heuristic(
        self, tmp_path, events, model, gh, capsys
    ):
        model.fail_to_create.append(ValueError("No OAuth token found"))

        result = asyncio.run(
            reviewer(tmp_path, events, use_ai=True).review_followup(context())
        )

        assert "Use of eval() detected" in [f.title for f in result.findings]
        assert "AI review failed: No OAuth token found" in capsys.readouterr().out

    def test_a_context_that_cannot_be_put_in_a_prompt_leaves_the_heuristic(
        self, tmp_path, events, model, gh
    ):
        result = asyncio.run(
            reviewer(tmp_path, events, use_ai=True).review_followup(
                context(commits_since_review=[{"sha": "abc", "commit": None}])
            )
        )

        assert model.clients == []
        assert "Use of eval() detected" in [f.title for f in result.findings]
