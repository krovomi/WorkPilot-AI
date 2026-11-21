"""The parallel PR review: four specialists side by side, then a validator.

`ParallelOrchestratorReviewer.review`
(runners/github/services/parallel_orchestrator_reviewer.py) is the default PR
review. It checks the PR's head out in a worktree, runs the security, quality,
logic and codebase-fit specialists as parallel sessions, merges what several
of them found at the same place (cross-validation raises its confidence),
drops findings whose line or file does not exist, asks a finding-validator
session to confirm or dismiss the rest, keeps what is in the PR's scope, and
turns the result, the CI checks and the merge state into a verdict and the
summary posted on the PR.

Real here: git and the worktree (`tests/pr_repo.py`), the prompts, the
parsing, the files the line check reads. Stand-ins: the model
(`tests/review_llm_fake.py`: `create_agent_client` for the specialists, the
Claude SDK client for the validator) and `gh` (`tests/gh_fake.py`).
"""

from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import sys

import pytest
from claude_agent_sdk import AssistantMessage, ResultMessage, TextBlock
from integrations.jev.models import JevAnswer, JevOutcome
from runners.github.context_gatherer import ChangedFile, PRContext
from runners.github.models import (
    BRANCH_BEHIND_BLOCKER_MSG,
    GitHubRunnerConfig,
    MergeVerdict,
    PRReviewFinding,
    ReviewCategory,
    ReviewSeverity,
)
from runners.github.orchestrator import ProgressCallback
from runners.github.services.parallel_orchestrator_reviewer import (
    ParallelOrchestratorReviewer,
    SpecialistConfig,
)

from tests.pr_repo import git, make_repo
from tests.review_llm_fake import StandInModel, structured, text

reviewer_module = importlib.import_module(
    "runners.github.services.parallel_orchestrator_reviewer"
)

SECURITY = "Analyze this PR for Security vulnerabilities"
QUALITY = "Analyze this PR for Code quality"
LOGIC = "Analyze this PR for Logic correctness"
FIT = "Analyze this PR for Naming conventions"
VALIDATE = "## Findings to Validate"
EVIDENCE = "query = 'SELECT ' + user_id"
EXPLANATION = "The finding claimed X; the code shows Y, which settles it."

CHECKS = "pr checks 7 --json name,state -R own/repo"
HEAD_OID = "pr view 7 --json headRefOid -R own/repo"
FILES = "api --method GET repos/{owner}/{repo}/pulls/7/files -f page=1 -f per_page=100"


def fid(file: str, line: int, title: str) -> str:
    return hashlib.md5(
        f"{file}:{line}:{title}".encode(), usedforsecurity=False
    ).hexdigest()[:12]


def spec(title, file="app.py", line=2, category="security", severity="high", **extra):
    return {
        "title": title,
        "file": file,
        "line": line,
        "category": category,
        "severity": severity,
        "description": f"{title}, explained.",
        "evidence": EVIDENCE,
        **extra,
    }


def specialist(name: str, *findings: dict) -> dict:
    return {
        "specialist_name": name,
        "analysis_summary": f"{name} looked.",
        "findings": list(findings),
    }


def validated(finding_id: str, status: str) -> dict:
    return {
        "finding_id": finding_id,
        "validation_status": status,
        "code_evidence": EVIDENCE,
        "line_range": [2, 2],
        "explanation": EXPLANATION,
        "evidence_verified_in_file": True,
    }


def verdict_of(*validations: dict) -> ResultMessage:
    return ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        structured_output={"validations": list(validations), "summary": "Checked."},
    )


@pytest.fixture
def project(tmp_path, monkeypatch):
    return make_repo(
        tmp_path,
        monkeypatch,
        {
            "app.py": "".join(f"line {n}\n" for n in range(1, 11)),
            "lib/util.py": "a\nb\nc\n",
            "README.md": "# Read me\n",
        },
    )


@pytest.fixture
def head(project):
    return git(project, "rev-parse", "HEAD")


@pytest.fixture
def model(monkeypatch):
    stand_in = StandInModel()
    monkeypatch.setattr(reviewer_module, "create_agent_client", stand_in.agent)
    monkeypatch.setattr(reviewer_module, "create_client", stand_in.sdk)
    return stand_in


@pytest.fixture
def forge(gh):
    gh.answer(
        {
            CHECKS: {"stdout": json.dumps([{"name": "lint", "state": "SUCCESS"}])},
            HEAD_OID: {"stdout": json.dumps({"headRefOid": ""})},
            FILES: {
                "stdout": json.dumps(
                    [{"filename": "app.py", "sha": "b10b"}, {"filename": "README.md"}]
                )
            },
        }
    )
    return gh


@pytest.fixture
def events():
    return []


@pytest.fixture
def reviewer(project, events):
    return ParallelOrchestratorReviewer(
        project,
        project / ".workpilot" / "github",
        GitHubRunnerConfig(
            token="placeholder",  # pragma: allowlist secret
            repo="own/repo",
        ),
        progress_callback=events.append,
    )


def pr(head_sha: str = "", **overrides) -> PRContext:
    values = {
        "pr_number": 7,
        "title": "Look users up",
        "description": "",
        "author": "ann",
        "base_branch": "main",
        "head_branch": "feat/lookup",
        "state": "open",
        "changed_files": [
            ChangedFile("app.py", "modified", 3, 1, "", "", "@@ -1 +1 @@\n+line 1"),
            ChangedFile("lib/util.py", "added", 3, 0, "", "", ""),
        ],
        "diff": "",
        "repo_structure": "",
        "related_files": [],
        "head_sha": head_sha,
        "commits": [{"oid": "c0ffee"}],
    }
    values.update(overrides)
    return PRContext(**values)


def review(reviewer, context):
    return asyncio.run(reviewer.review(context))


class TestTheReview:
    def test_specialists_findings_are_merged_checked_validated_and_scoped(
        self, reviewer, model, forge, head, project, events
    ):
        model.answer(
            structured(
                specialist(
                    "security",
                    spec("SQL injection", severity="critical", end_line=4),
                    spec("Past the end", line=50),
                    spec("Nowhere", file="missing.py", line=1),
                    spec("Docs drift", file="README.md", line=1, category="docs"),
                    spec(
                        "Callers break",
                        file="README.md",
                        line=1,
                        category="logic",
                        is_impact_finding=True,
                        suggested_fix="Update the callers.",
                    ),
                    spec("At line zero", line=0, category="pattern"),
                    spec("No file", file="", line=1, category="test"),
                )
            ),
            when=SECURITY,
        )
        model.answer(
            structured(specialist("quality", spec("Unsafe query", severity="high"))),
            when=QUALITY,
        )
        dict_finding = {
            "title": "Off by one",
            "file": "lib/util.py",
            "line": 1,
            "category": "logic",
            "severity": "low",
            "evidence": "a",
        }
        model.answer(
            text(
                "Found one:\n```json\n"
                + json.dumps({"findings": [dict_finding]})
                + "\n```"
            ),
            when=LOGIC,
        )
        model.answer(ConnectionError("provider went away"), when=FIT)
        merged = fid("app.py", 2, "SQL injection")
        model.answer(
            verdict_of(
                validated(merged, "confirmed_valid"),
                validated(
                    fid("lib/util.py", 1, "Off by one"), "dismissed_false_positive"
                ),
                validated(fid("README.md", 1, "Callers break"), "needs_human_review"),
            ),
            when=VALIDATE,
        )

        result = review(reviewer, pr(head))

        assert result.success
        by_title = {f.title: f for f in result.findings}
        assert set(by_title) == {"SQL injection", "[NEEDS REVIEW] Callers break"}
        primary = by_title["SQL injection"]
        assert primary.cross_validated
        assert primary.source_agents == ["security", "quality"]
        assert primary.confidence == pytest.approx(0.65)
        assert (
            primary.description
            == "SQL injection, explained. | Unsafe query, explained."
        )
        assert primary.validation_status == "confirmed_valid"
        assert result.verdict == MergeVerdict.BLOCKED
        assert result.overall_status == "request_changes"
        assert "Critical: SQL injection (app.py:2)" in result.blockers
        assert result.reviewed_commit_sha == "c0ffee"
        assert result.reviewed_file_blobs == {"app.py": "b10b"}
        summary = result.summary
        assert (
            "**Specialist Agents Invoked:** security, quality, logic, codebase-fit"
            in summary
        )
        assert "**File:** `app.py` (L2-L4)" in summary
        assert "**Cross-validated** by 2 agents: security, quality" in summary
        assert "**Validation:** Confirmed" in summary
        assert "**Validation:** Needs human review" in summary
        assert f"**Reasoning:** {EXPLANATION}" in summary
        assert "**Suggested fix:** Update the callers." in summary
        assert "**Total:** 2 finding(s) (1 critical, 1 high)" in summary
        assert "CI: 1 check(s) passing" in result.verdict_reasoning
        specialists = [
            c for c in model.clients if c.prompt and VALIDATE not in c.prompt
        ]
        assert len(specialists) == 4
        assert {c.options["roster"] for c in specialists} == {"solo"}
        assert {c.options["agent_type"] for c in specialists} == {"pr_reviewer"}
        worktree = specialists[0].options["project_dir"]
        assert worktree.name.startswith("pr-7-") and not worktree.exists()
        [validator] = [c for c in model.clients if VALIDATE in (c.prompt or "")]
        assert validator.options["agent_type"] == "pr_finding_validator"
        assert validator.options["project_dir"] == worktree
        assert [(e.phase, e.progress) for e in events] == [
            ("orchestrating", 35),
            ("orchestrating", 40),
            ("finalizing", 50),
            ("analyzed", 60),
        ]
        assert all(isinstance(e, ProgressCallback) for e in events)

    def test_a_pr_without_findings_is_ready_to_merge(self, reviewer, model, forge):
        model.answer(structured(specialist("any")))
        outcome = JevOutcome(
            status="evaluated", answers={"risk": JevAnswer("choice", "low", 0.9)}
        )

        result = review(reviewer, pr(commits=[{"sha": "beef"}], jev_outcome=outcome))

        assert all("Optional JEV assessment" in p for p in model.prompts)
        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert result.overall_status == "approve"
        assert result.reviewed_commit_sha == "beef"
        assert not [c for c in model.clients if VALIDATE in (c.prompt or "")]
        assert "### Findings" not in result.summary

    def test_a_review_that_fails_says_so_and_removes_its_worktree(
        self, project, model, gh, head
    ):
        def broken_callback(event):
            if event.progress == 40:
                raise RuntimeError("the app went away")

        reviewer = ParallelOrchestratorReviewer(
            project,
            project / ".workpilot" / "github",
            GitHubRunnerConfig(
                token="placeholder",  # pragma: allowlist secret
                repo="own/repo",
            ),
            progress_callback=broken_callback,
        )

        result = review(reviewer, pr(head))

        assert not result.success and result.error == "the app went away"
        worktrees = project / ".workpilot" / "github" / "pr" / "worktrees"
        assert not list(worktrees.glob("pr-7-*"))

    def test_a_specialist_that_cannot_even_build_its_prompt_is_left_out(
        self, reviewer, model, forge
    ):
        broken = JevOutcome(status="evaluated", answers={"risk": "not an answer"})

        result = review(reviewer, pr(jev_outcome=broken))

        assert result.success and result.findings == []
        assert model.clients == []

    def test_a_specialist_that_cannot_start_is_left_out(self, reviewer, model, forge):
        model.fail_to_create.append(RuntimeError("no credentials for the provider"))
        model.answer(structured(specialist("any", spec("Typo", category="docs"))))
        model.answer(verdict_of(), when=VALIDATE)

        result = review(reviewer, pr()).findings

        assert len(model.clients) == 4  # three specialists and the validator
        assert [f.title for f in result] == ["Typo"]
        assert result[0].source_agents == ["quality"]  # the same finding, once

    def test_unreadable_ci_status_is_read_as_no_checks(self, reviewer, model, gh):
        gh.answer({CHECKS: {"stdout": json.dumps(["not a check"])}})
        model.answer(structured(specialist("any")))

        result = review(reviewer, pr(commits=[]))

        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert result.reviewed_commit_sha is None
        assert result.reviewed_file_blobs == {}


class TestWhereTheSpecialistsRead:
    @pytest.mark.parametrize("debug", [False, True])
    def test_without_a_head_commit_the_checkout_is_read(
        self, reviewer, model, forge, project, monkeypatch, debug
    ):
        monkeypatch.setattr(reviewer_module, "DEBUG_MODE", debug)
        model.answer(structured(specialist("any")))

        review(reviewer, pr("", head_branch=""))

        assert {c.options["project_dir"] for c in model.clients} == {project}

    def test_an_unsafe_head_ref_is_never_checked_out(
        self, reviewer, model, forge, project
    ):
        model.answer(structured(specialist("any")))

        review(reviewer, pr("", head_branch="feat; rm -rf /"))

        assert {c.options["project_dir"] for c in model.clients} == {project}

    def test_a_worktree_is_never_made_for_an_unsafe_ref(self, reviewer):
        with pytest.raises(ValueError, match="Invalid git ref"):
            reviewer._create_pr_worktree("feat; rm -rf /", 7)

    @pytest.mark.parametrize("debug", [False, True])
    def test_a_head_the_repository_lacks_falls_back_to_the_checkout(
        self, reviewer, model, forge, project, monkeypatch, debug
    ):
        monkeypatch.setattr(reviewer_module, "DEBUG_MODE", debug)
        model.answer(structured(specialist("any")))

        review(reviewer, pr("0123456789abcdef0123456789abcdef01234567"))

        assert {c.options["project_dir"] for c in model.clients} == {project}

    def test_from_the_backend_folder_the_repository_root_is_read(
        self, tmp_path, model, forge
    ):
        backend = tmp_path / "apps" / "backend"
        backend.mkdir(parents=True)
        reviewer = ParallelOrchestratorReviewer(
            backend,
            tmp_path / "gh",
            GitHubRunnerConfig(
                token="placeholder",  # pragma: allowlist secret
                repo="own/repo",
                model="",
                thinking_level="",
            ),
        )
        model.answer(structured(specialist("any")))

        review(reviewer, pr(""))
        review(reviewer, pr("0123456789abcdef0123456789abcdef01234567"))

        assert {c.options["project_dir"] for c in model.clients} == {tmp_path}

    def test_a_large_worktree_is_announced_with_a_lower_bound(
        self, reviewer, model, forge, head, monkeypatch, capsys
    ):
        monkeypatch.setattr(reviewer_module, "WORKTREE_FILE_COUNT_LIMIT", 2)
        monkeypatch.setattr(reviewer_module, "DEBUG_MODE", True)
        model.answer(structured(specialist("any")))

        review(reviewer, pr(head))

        printed = capsys.readouterr().out
        assert "(2+ files)" in printed
        assert "DEBUG: Creating worktree" in printed

    def test_stale_review_worktrees_are_cleaned_first(
        self, reviewer, model, forge, project
    ):
        stale = project / ".workpilot" / "github" / "pr" / "worktrees" / "pr-1-dead"
        stale.mkdir(parents=True)
        model.answer(structured(specialist("any")))

        review(reviewer, pr(""))

        assert not stale.exists()

    def test_progress_goes_through_the_runner_s_orchestrator_when_it_has_one(
        self, reviewer, model, forge, events, monkeypatch
    ):
        runner_copy = importlib.import_module("runners.github.orchestrator")
        monkeypatch.setitem(sys.modules, "orchestrator", runner_copy)
        model.answer(structured(specialist("any")))

        review(reviewer, pr(""))

        assert len(events) == 4

    def test_without_a_progress_callback_nothing_is_reported(self, reviewer):
        reviewer.progress_callback = None

        reviewer._report_progress("orchestrating", 1, "quiet")

    def test_a_missing_specialist_prompt_falls_back_to_its_role(
        self, reviewer, project, tmp_path
    ):
        reviewer.prompts_dir = tmp_path / "no-prompts"
        config = SpecialistConfig("perf", "pr_perf_agent.md", [], "slow paths")

        prompt = reviewer._build_specialist_prompt(config, pr(""), project)

        assert "You are a perf specialist for PR review." in prompt
        assert "**PR #7**: Look users up" in prompt
        assert "(No description provided)" in prompt

    def test_a_very_large_diff_is_cut_for_each_specialist(self, reviewer, project):
        big = ChangedFile("big.py", "added", 1, 0, "", "", "+" * 160_000)

        prompt = reviewer._build_specialist_prompt(
            reviewer_module.SPECIALIST_CONFIGS[0], pr("", changed_files=[big]), project
        )

        assert "... (diff truncated)" in prompt


class TestTheSpecialistAnswer:
    def test_an_answer_outside_the_schema_is_read_as_text(self, reviewer):
        found = reviewer._parse_specialist_output(
            "quality",
            {"findings": "not a list"},
            '{"findings": [{"title": "T", "severity": "urgent"}]}',
        )

        assert [(f.title, f.severity, f.file) for f in found] == [
            ("T", ReviewSeverity.MEDIUM, "unknown")
        ]
        assert found[0].source_agents == ["quality"]

    @pytest.mark.parametrize(
        "answer",
        ["no json here", "{ never closed", "```json\n{not json}\n```", ""],
    )
    def test_an_answer_without_readable_json_has_no_findings(self, reviewer, answer):
        assert reviewer._parse_specialist_output("logic", None, answer) == []

    def test_a_text_answer_without_findings_has_none(self, reviewer):
        assert reviewer._parse_text_output('{"summary": "ok"}') == []


class TestTheLineCheck:
    def test_a_finding_on_a_folder_is_kept_since_its_length_is_unknown(
        self, reviewer, project
    ):
        folder = PRReviewFinding(
            id="d",
            severity=ReviewSeverity.LOW,
            category=ReviewCategory.QUALITY,
            title="Layout",
            description="",
            file="lib",
            line=3,
        )
        again = PRReviewFinding(
            id="e",
            severity=ReviewSeverity.LOW,
            category=ReviewCategory.QUALITY,
            title="Layout too",
            description="",
            file="lib",
            line=4,
        )

        valid, rejected = reviewer._verify_line_numbers([folder, again], project)

        assert valid == [folder, again] and rejected == []


def finding(fid_: str, severity=ReviewSeverity.HIGH) -> PRReviewFinding:
    return PRReviewFinding(
        id=fid_,
        severity=severity,
        category=ReviewCategory.SECURITY,
        title=f"Finding {fid_}",
        description="d",
        file="app.py",
        line=2,
        evidence=EVIDENCE,
    )


class TestTheValidator:
    def validate(self, reviewer, project, findings):
        return asyncio.run(reviewer._validate_findings(findings, pr(""), project))

    def test_nothing_to_validate_asks_nothing(self, reviewer, model, project):
        assert self.validate(reviewer, project, []) == []
        assert model.clients == []

    def test_a_validator_that_cannot_start_is_tried_again(
        self, reviewer, model, project
    ):
        model.fail_to_create.append(RuntimeError("no token yet"))
        model.answer(verdict_of(validated("a", "dismissed_false_positive")))

        assert self.validate(reviewer, project, [finding("a")]) == []
        assert len(model.clients) == 1

    @pytest.mark.parametrize(
        "first",
        [
            [
                AssistantMessage(
                    content=[TextBlock(text="API Error: 400 tool_use")], model="m"
                )
            ],
            [AssistantMessage(content=[TextBlock(text="nothing")], model="m")],
        ],
        ids=["retryable-error", "no-output"],
    )
    def test_a_retryable_answer_is_asked_again(self, reviewer, model, project, first):
        replies = [first, [verdict_of(validated("a", "confirmed_valid"))]]
        model.answer_with(lambda _prompt, _options: replies.pop(0))

        kept = self.validate(reviewer, project, [finding("a")])

        assert [f.validation_status for f in kept] == ["confirmed_valid"]
        assert len(model.clients) == 2

    def test_a_rate_limited_stream_is_asked_again(self, reviewer, model, project):
        model.fail_to_query.append(RuntimeError("rate limited, slow down"))
        model.answer(verdict_of(validated("a", "confirmed_valid")))

        kept = self.validate(reviewer, project, [finding("a")])

        assert [f.id for f in kept] == ["a"]
        assert len(model.clients) == 2

    @pytest.mark.parametrize(
        ("setup", "label"),
        [
            (lambda m: m.answer(RuntimeError("socket closed")), "stream-error"),
            (lambda m: m.fail_to_query.append(KeyError("boom")), "query-error"),
            (
                lambda m: m.answer(
                    AssistantMessage(
                        content=[TextBlock(text="400 tool_use")], model="m"
                    ),
                    AssistantMessage(content=[TextBlock(text="api error")], model="m"),
                ),
                "retries-exhausted",
            ),
            (lambda m: m.answer(), "no-output-ever"),
            (
                lambda m: m.fail_to_create.extend([RuntimeError("x")] * 3),
                "never-starts",
            ),
            (
                lambda m: m.fail_to_query.extend([RuntimeError("rate")] * 3),
                "rate-limited-throughout",
            ),
            (
                lambda m: m.answer(
                    ResultMessage(
                        subtype="success",
                        duration_ms=1,
                        duration_api_ms=1,
                        is_error=False,
                        num_turns=1,
                        session_id="s",
                        structured_output={"validations": "?"},
                    )
                ),
                "invalid-output",
            ),
        ],
        ids=lambda v: v if isinstance(v, str) else "",
    )
    def test_a_validator_that_fails_keeps_every_finding(
        self, reviewer, model, project, setup, label
    ):
        setup(model)
        findings = [finding("a"), finding("b")]

        assert self.validate(reviewer, project, findings) == findings

    def test_a_finding_the_validator_did_not_mention_is_kept(
        self, reviewer, model, project
    ):
        model.answer(verdict_of(validated("other", "confirmed_valid")))

        assert [f.id for f in self.validate(reviewer, project, [finding("a")])] == ["a"]


class TestTheVerdict:
    @pytest.mark.parametrize(
        ("severities", "conflicts", "state", "ci", "verdict", "words"),
        [
            (
                [],
                False,
                "",
                {"failing": 4, "failed_checks": list("abcd")},
                "BLOCKED",
                "+1 more",
            ),
            (
                ["critical"],
                False,
                "",
                {"failing": 1, "failed_checks": ["a"]},
                "BLOCKED",
                "Also 1 critical",
            ),
            (
                ["high"],
                False,
                "",
                {"failing": 1, "failed_checks": ["a"]},
                "BLOCKED",
                "Also 1 code issue",
            ),
            (
                [],
                False,
                "",
                {"awaiting_approval": 1},
                "BLOCKED",
                "Maintainer must approve",
            ),
            ([], True, "", {}, "BLOCKED", "merge conflicts"),
            (["critical"], False, "", {}, "BLOCKED", "1 critical code issue"),
            (
                ["medium"],
                False,
                "",
                {"pending": 1},
                "NEEDS_REVISION",
                "1 code issue(s) + CI",
            ),
            ([], False, "", {"pending": 1}, "NEEDS_REVISION", "Wait for CI"),
            (["high", "low"], False, "BEHIND", {}, "NEEDS_REVISION", "1 suggestion(s)"),
            ([], False, "BEHIND", {}, "NEEDS_REVISION", "Branch is out of date"),
            (["medium", "low"], False, "", {}, "NEEDS_REVISION", "(0 high, 1 medium)"),
            (["medium"], False, "", {}, "NEEDS_REVISION", "1 code issue(s)"),
            (["low"], False, "", {}, "READY_TO_MERGE", "1 suggestion(s)"),
            ([], False, "", None, "READY_TO_MERGE", "No blocking issues"),
        ],
    )
    def test_the_verdict_weighs_ci_conflicts_the_branch_and_the_findings(
        self, reviewer, severities, conflicts, state, ci, verdict, words
    ):
        findings = [
            finding(str(n), ReviewSeverity(s)) for n, s in enumerate(severities)
        ]

        got, reasoning, blockers = reviewer._generate_verdict(
            findings,
            has_merge_conflicts=conflicts,
            merge_state_status=state,
            ci_status=ci,
        )

        assert got == MergeVerdict[verdict]
        assert words in reasoning
        if state == "BEHIND" and not conflicts:
            assert BRANCH_BEHIND_BLOCKER_MSG in blockers

    def test_a_merge_with_changes_verdict_reads_as_a_comment(self, reviewer):
        summary = reviewer._generate_summary(
            MergeVerdict.MERGE_WITH_CHANGES, "Minor.", [], [], []
        )

        assert "🟡 MERGE WITH CHANGES" in summary
        assert "Specialist Agents" not in summary and "Blocking" not in summary

    def test_a_finding_without_evidence_or_validation_is_listed_plainly(self, reviewer):
        bare = finding("a", ReviewSeverity.LOW)
        bare.evidence = None
        bare.end_line = 2
        odd = finding("b", ReviewSeverity.MEDIUM)
        odd.validation_status = "unchecked"

        summary = reviewer._generate_summary(
            MergeVerdict.READY_TO_MERGE, "Fine.", [], [bare, odd], ["quality"]
        )

        assert "**File:** `app.py` (L2)" in summary
        assert "**Validation:** unchecked" in summary
        assert "Verification details" not in summary
        assert "**Total:** 2 finding(s) (1 medium, 1 low)" in summary

    def test_validation_details_without_reasoning_are_shown(self, reviewer):
        checked = finding("a")
        checked.validation_status = "confirmed_valid"
        checked.validation_evidence = "the line"
        checked.cross_validated = True
        checked.source_agents = []

        summary = reviewer._generate_summary(
            MergeVerdict.NEEDS_REVISION, "Fix.", ["x"], [checked], []
        )

        assert "Verification details" in summary and "**Reasoning:**" not in summary
        assert "Cross-validated" not in summary


class TestCrossValidation:
    def test_findings_at_one_place_merge_and_lonely_ones_stay(self, reviewer):
        a = finding("a", ReviewSeverity.MEDIUM)
        a.source_agents = ["security"]
        b = finding("b", ReviewSeverity.HIGH)
        b.source_agents = ["security"]
        b.evidence = "  "
        c = finding("c", ReviewSeverity.LOW)
        c.description = ""
        d = finding("d")
        d.description = a.description
        alone = finding("e")
        alone.line = 9

        merged, agreement = reviewer._cross_validate_findings([a, b, c, d, alone])

        assert [f.id for f in merged] == ["b", "e"]
        assert merged[0].source_agents == ["security"]
        assert merged[0].evidence == f"{EVIDENCE}\n---\n{EVIDENCE}\n---\n{EVIDENCE}"
        assert merged[0].description == "d"
        assert merged[1].source_agents == [] and not merged[1].cross_validated
        assert agreement.agreed_findings == ["b"]
