"""What the model is shown of a GitLab MR, and how its answer becomes a review.

The review engine writes the prompt (the MR's title, description and diff,
cleaned, bounded and marked as untrusted), reads the model's streamed answer,
and turns the JSON review in it into findings, blockers and a verdict; it
also writes the summary the MR is shown. The model is a stand-in.
"""

from __future__ import annotations

import asyncio
import importlib

import pytest
from runners.gitlab.models import (
    GitLabRunnerConfig,
    MergeVerdict,
    MRContext,
    MRReviewFinding,
    ReviewCategory,
    ReviewSeverity,
)
from runners.gitlab.services import MRReviewEngine
from security.content_sanitizer import MAX_DIFF_CHARS


@pytest.fixture
def engine(tmp_path):
    progress = []
    project = tmp_path / "shop"
    project.mkdir()
    made = MRReviewEngine(
        project_dir=project,
        gitlab_dir=project / ".workpilot" / "gitlab",
        config=GitLabRunnerConfig(token="t", project="group/app", model="m"),
        progress_callback=progress.append,
    )
    made.progress = progress
    return made


def context(**fields) -> MRContext:
    values = {
        "mr_iid": 3,
        "title": "Fix cart total",
        "description": "Rounds once.",
        "author": "bob",
        "source_branch": "fix/total",
        "target_branch": "main",
        "state": "opened",
        "changed_files": [{"new_path": "cart.py", "old_path": "cart.py"}],
        "diff": "+total = round(total, 2)",
        **fields,
    }
    return MRContext(**values)


def review(engine, ctx: MRContext):
    return asyncio.run(engine.run_review(ctx))


def quoted(prompt: str, heading: str) -> str:
    """The text quoted under one heading of the change section."""
    section = prompt.split(f"{heading}\n", 1)[1]
    assert section.startswith("<user_content>\n")
    return section[len("<user_content>\n") :].split("\n</user_content>", 1)[0]


class TestThePrompt:
    def test_the_mr_content_is_quoted_as_data(self, engine, model, llm):
        stand_in = model(llm.says(llm.review()))

        review(engine, context())

        prompt = stand_in.prompts[0]
        assert prompt.startswith("You are a senior code reviewer")
        assert quoted(prompt, "### Details") == (
            "Author: bob\nSource branch: fix/total\nTarget branch: main\n"
            "Files changed:\n- cart.py"
        )
        assert quoted(prompt, "### Title") == "Fix cart total"
        assert quoted(prompt, "### Description") == "Rounds once."
        assert quoted(prompt, "### Diff") == "+total = round(total, 2)"
        assert "quoted as data" in prompt

    def test_control_characters_are_removed_and_long_content_cut(
        self, engine, model, llm
    ):
        stand_in = model(llm.says(llm.review()))

        review(
            engine,
            context(title="Fix\x00 cart\x1b total\x7f", diff="+x\n" * 60000),
        )

        prompt = stand_in.prompts[0]
        assert quoted(prompt, "### Title") == "Fix cart total"
        assert "\x00" not in prompt and "\x1b" not in prompt
        assert len(quoted(prompt, "### Diff")) <= MAX_DIFF_CHARS

    def test_only_the_first_thirty_files_are_listed(self, engine, model, llm):
        stand_in = model(llm.says(llm.review()))
        files = [{"new_path": f"f{i}.py"} for i in range(32)]

        review(engine, context(changed_files=files))

        listed = quoted(stand_in.prompts[0], "### Details").splitlines()
        assert "- f29.py" in listed
        assert "- f30.py" not in listed
        assert listed[-1] == "- ... and 2 more files"

    def test_a_deleted_file_is_listed_by_its_old_path(self, engine, model, llm):
        stand_in = model(llm.says(llm.review()))

        review(engine, context(changed_files=[{"old_path": "gone.py"}]))

        assert quoted(stand_in.prompts[0], "### Details").endswith("\n- gone.py")

    def test_codebase_context_is_added_when_there_is_some(self, engine, model, llm):
        stand_in = model(llm.says(llm.review()))

        review(
            engine,
            context(
                deep_context={
                    "context_available": True,
                    "architecture_style": "hexagonal",
                }
            ),
        )

        assert "## Deep Codebase Context" in stand_in.prompts[0]
        assert "hexagonal" in stand_in.prompts[0]

    def test_codebase_context_that_found_nothing_adds_nothing(self, engine, model, llm):
        stand_in = model(llm.says(llm.review()))

        review(engine, context(deep_context={"context_available": False}))

        assert "Deep Codebase Context" not in stand_in.prompts[0]

    def test_a_jev_assessment_is_passed_on_as_advice(self, engine, model, llm):
        jev = importlib.import_module("integrations.jev.models")
        stand_in = model(llm.says(llm.review()))
        outcome = jev.JevOutcome(
            "evaluated", answers={"risk": jev.JevAnswer("choice", "low", 0.9)}
        )

        review(engine, context(jev_outcome=outcome))

        assert "Optional JEV assessment (advisory only" in stand_in.prompts[0]
        assert "- risk: low; confidence: 0.9" in stand_in.prompts[0]

    def test_the_reviewer_works_in_the_project_folder(self, engine, model, llm):
        stand_in = model(llm.says(llm.review()))

        review(engine, context())

        assert stand_in.created_with["project_dir"] == engine.project_dir
        assert stand_in.created_with["spec_dir"] == engine.gitlab_dir

    def test_a_review_runs_without_a_progress_listener(self, engine, model, llm):
        model(llm.says(llm.review("blocked")))
        engine.progress_callback = None

        _findings, verdict, *_ = review(engine, context())

        assert verdict == MergeVerdict.BLOCKED


class TestReadingTheAnswer:
    def test_only_the_assistant_text_is_read(self, engine, model, llm):
        ac = importlib.import_module("core.agent_client")
        answer = llm.review("blocked", [llm.finding("Overflow", "critical")])
        model(
            [
                ac.AgentMessage(
                    role=ac.MessageRole.USER,
                    content=[ac.ContentBlock(type=ac.ContentBlockType.TEXT, text="{")],
                ),
                ac.AgentMessage(
                    role=ac.MessageRole.ASSISTANT,
                    content=[
                        ac.ContentBlock(
                            type=ac.ContentBlockType.THINKING, text="```json {"
                        ),
                        ac.ContentBlock(
                            type=ac.ContentBlockType.TOOL_USE, tool_name="Read"
                        ),
                        ac.ContentBlock(type=ac.ContentBlockType.TEXT, text=answer),
                    ],
                ),
            ]
        )

        findings, verdict, _summary, blockers = review(engine, context())

        assert verdict == MergeVerdict.BLOCKED
        assert [f.title for f in findings] == ["Overflow"]
        assert blockers == ["Overflow (app/login.py:2)"]
        assert [p.progress for p in engine.progress] == [30, 70]

    def test_findings_keep_what_the_model_said(self, engine, model, llm):
        model(
            llm.says(
                llm.review(
                    "merge_with_changes",
                    [
                        llm.finding(
                            "Use a constant",
                            "low",
                            category="style",
                            end_line=4,
                            suggested_fix="MAX = 3",
                            fixable=True,
                        )
                    ],
                    summary="Fine overall.",
                )
            )
        )

        findings, verdict, summary, blockers = review(engine, context())

        (only,) = findings
        assert only.id.startswith("finding-")
        assert (only.severity, only.category) == (
            ReviewSeverity.LOW,
            ReviewCategory.STYLE,
        )
        assert (only.end_line, only.suggested_fix, only.fixable) == (4, "MAX = 3", True)
        assert verdict == MergeVerdict.MERGE_WITH_CHANGES
        assert summary == "Fine overall."
        assert blockers == []

    def test_a_finding_with_missing_fields_gets_defaults(self, engine, model, llm):
        model(llm.says(llm.review(findings=[{}])))

        (only,), *_ = review(engine, context())

        assert (only.severity, only.category) == (
            ReviewSeverity.MEDIUM,
            ReviewCategory.QUALITY,
        )
        assert (only.title, only.file, only.line) == ("Untitled finding", "unknown", 1)

    def test_findings_the_review_cannot_use_are_skipped(self, engine, model, llm):
        model(
            llm.says(
                llm.review(
                    findings=[
                        llm.finding("Bad severity", "urgent"),
                        llm.finding("Bad category", category="vibes"),
                        "not a finding",
                        llm.finding("Kept"),
                    ]
                )
            )
        )

        findings, *_ = review(engine, context())

        assert [f.title for f in findings] == ["Kept"]

    def test_an_unknown_verdict_counts_as_ready_to_merge(self, engine, model, llm):
        model(llm.says(llm.review("ship_it")))

        _findings, verdict, *_ = review(engine, context())

        assert verdict == MergeVerdict.READY_TO_MERGE

    @pytest.mark.parametrize(
        "answer",
        [
            "Looks fine to me.",
            "```json\n{ not json }\n```",
            '```json\n["a", "list"]\n```',
            "",
        ],
        ids=["prose", "broken-json", "not-an-object", "nothing"],
    )
    def test_an_answer_without_a_readable_review_asks_for_caution(
        self, engine, model, llm, answer
    ):
        model(llm.says(answer) if answer else [])

        findings, verdict, summary, blockers = review(engine, context())

        assert (findings, blockers) == ([], [])
        assert verdict == MergeVerdict.MERGE_WITH_CHANGES
        assert "Please re-run the review" in summary

    def test_a_model_failure_becomes_a_review_failure(self, engine, model):
        model(fail=TimeoutError("no answer"))

        with pytest.raises(RuntimeError, match="Review failed: no answer"):
            review(engine, context())


class TestTheSummary:
    def finding(self, severity: ReviewSeverity) -> MRReviewFinding:
        return MRReviewFinding(
            f"id-{severity.value}",
            severity,
            ReviewCategory.QUALITY,
            "t",
            "d",
            "f.py",
            1,
        )

    def test_it_states_the_verdict_the_blockers_and_the_counts(self, engine):
        findings = [
            self.finding(ReviewSeverity.LOW),
            self.finding(ReviewSeverity.CRITICAL),
            self.finding(ReviewSeverity.LOW),
        ]

        summary = engine.generate_summary(
            findings, MergeVerdict.BLOCKED, "Unsafe.", ["Leak (a.py:1)"]
        )

        lines = summary.splitlines()
        assert lines[0] == "### Merge Verdict: 🔴 BLOCKED"
        assert lines[1] == "Unsafe."
        assert "- Leak (a.py:1)" in lines
        assert "- **Critical**: 1 issue(s)" in lines
        assert "- **Low**: 2 issue(s)" in lines
        assert not any("**High**" in line for line in lines)
        assert lines[-1] == "_Generated by WorkPilot AI MR Review_"

    def test_a_clean_review_has_no_blocker_or_findings_section(self, engine):
        summary = engine.generate_summary([], MergeVerdict.READY_TO_MERGE, "Good.", [])

        assert summary.startswith("### Merge Verdict: ✅ READY TO MERGE")
        assert "Blocking Issues" not in summary
        assert "Findings Summary" not in summary
