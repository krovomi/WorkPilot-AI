"""Where the learned suppressions meet the PR review (#361).

The rules themselves are tested in ``test_review_feedback_learning.py``; here,
that the review applies them after it ran, whatever the model did, and that
each reviewer's prompt gets the block — read from the project, never from the
PR's worktree.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest
import runners.github.orchestrator as orchestrator_module
from learning_loop import review_feedback as rf
from runners.github.context_gatherer import ChangedFile, PRContext
from runners.github.models import (
    FollowupReviewContext,
    GitHubRunnerConfig,
    MergeVerdict,
    PRReviewFinding,
    PRReviewResult,
    ReviewCategory,
    ReviewPass,
    ReviewSeverity,
)
from runners.github.services.learned_suppression import (
    apply_to_followup,
)
from runners.github.services.parallel_followup_reviewer import (
    ParallelFollowupReviewer,
)
from runners.github.services.parallel_orchestrator_reviewer import (
    SPECIALIST_CONFIGS,
    ParallelOrchestratorReviewer,
)
from runners.github.services.pr_review_engine import PRReviewEngine


def _rejections(project: Path, n: int, title: str = "Missing docstring on `foo`"):
    path = project / ".workpilot" / "code_review_feedback.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        json.dumps(
            {
                "v": 1,
                "pr": 100 + i,
                "finding_id": f"f{i}",
                "verdict": "rejected",
                "reason": "too_pedantic",
                "category": "style",
                "severity": "low",
                "title": title,
            }
        )
        for i in range(n)
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _finding(fid: str, title: str, severity=ReviewSeverity.MEDIUM) -> PRReviewFinding:
    return PRReviewFinding(
        id=fid,
        severity=severity,
        category=ReviewCategory.STYLE,
        title=title,
        description="d",
        file="a.py",
        line=1,
    )


def _context() -> PRContext:
    return PRContext(
        pr_number=5,
        title="Add a feature",
        description="body",
        author="someone",
        base_branch="develop",
        head_branch="feat",
        state="open",
        changed_files=[
            ChangedFile("a.py", "modified", 3, 1, "", "", "@@ -1 +1 @@\n-x\n+y")
        ],
        diff="@@ -1 +1 @@\n-x\n+y",
        repo_structure="",
        related_files=[],
        total_additions=3,
        total_deletions=1,
    )


@pytest.fixture
def config() -> GitHubRunnerConfig:
    return GitHubRunnerConfig(token="test-token-0000", repo="owner/repo")


class TestReviewApplies:
    def _orchestrator(self, project: Path, config, findings, monkeypatch):
        orch = orchestrator_module.GitHubOrchestrator.__new__(
            orchestrator_module.GitHubOrchestrator
        )
        orch.project_dir = project
        orch.github_dir = project / ".workpilot" / "github"
        orch.github_dir.mkdir(parents=True, exist_ok=True)
        orch.config = config
        orch._jev_worker = None
        orch._report_progress = lambda *a, **k: None

        async def _no_deep_context(**_kwargs):
            raise TimeoutError("no deep context in this test")

        async def _run_review(_context):
            return findings, [], [], {}

        async def _checks(_number):
            return {}

        async def _files(_number):
            return []

        orch.deep_context_provider = SimpleNamespace(
            gather_deep_context=_no_deep_context
        )
        orch.pr_review_engine = SimpleNamespace(run_multi_pass_review=_run_review)
        orch.gh_client = SimpleNamespace(
            get_pr_checks_comprehensive=_checks, get_pr_files=_files
        )
        orch.bot_detector = SimpleNamespace(
            should_skip_pr_review=lambda **_k: (False, ""),
            mark_review_started=lambda _n: None,
            mark_review_finished=lambda _n, success=True: None,
            get_last_commit_sha=lambda _c: "abc123",
            mark_reviewed=lambda _n, _sha: None,
        )

        class _Gatherer:
            def __init__(self, *_a, **_k):
                pass

            async def gather(self):
                return _context()

        async def _nothing(*_a, **_k):
            return None

        monkeypatch.setattr(orchestrator_module, "PRContextGatherer", _Gatherer)
        monkeypatch.setattr(orchestrator_module, "store_review_learnings", _nothing)
        monkeypatch.setattr(orchestrator_module, "observe_with_hermes", _nothing)
        # By module object: a dotted string walks `integrations` attribute by
        # attribute, and that walk depends on which tests imported what first.
        jev_reviews = importlib.import_module("integrations.jev.reviews")
        monkeypatch.setattr(jev_reviews, "evaluate_context", _nothing)
        return orch

    def test_the_saved_review_carries_what_the_feedback_did(
        self, tmp_path, config, monkeypatch
    ):
        _rejections(tmp_path, 6, title="Missing docstring on `foo`")
        _rejections_path = tmp_path / ".workpilot" / "code_review_feedback.jsonl"
        extra = [
            json.dumps(
                {
                    "v": 1,
                    "pr": 300 + i,
                    "finding_id": f"g{i}",
                    "verdict": "not_applicable",
                    "reason": None,
                    "category": "style",
                    "severity": "medium",
                    "title": "Prefer an early return",
                }
            )
            for i in range(3)
        ]
        with open(_rejections_path, "a", encoding="utf-8") as handle:
            handle.write("\n".join(extra) + "\n")
        findings = [
            _finding("dropped", "Missing docstring on `bar`"),
            _finding("lowered", "Prefer an early return", ReviewSeverity.HIGH),
            _finding("kept", "Possible None dereference", ReviewSeverity.HIGH),
        ]
        orch = self._orchestrator(tmp_path, config, findings, monkeypatch)

        result = asyncio.run(orch.review_pr(5))

        assert result.success, result.error
        by_id = {f.id: f for f in result.findings}
        assert set(by_id) == {"lowered", "kept"}
        assert by_id["lowered"].severity == ReviewSeverity.LOW
        assert by_id["lowered"].learned_rejections == 3
        assert by_id["kept"].severity == ReviewSeverity.HIGH
        assert [s["id"] for s in result.learned_suppressions] == ["dropped"]
        saved = PRReviewResult.load(orch.github_dir, 5)
        assert saved is not None
        assert saved.learned_suppressions[0]["rejections"] == 6

    def test_without_feedback_the_review_is_unchanged(
        self, tmp_path, config, monkeypatch
    ):
        findings = [_finding("a", "Missing docstring on `bar`")]
        orch = self._orchestrator(tmp_path, config, findings, monkeypatch)

        result = asyncio.run(orch.review_pr(5))

        assert [f.severity for f in result.findings] == [ReviewSeverity.MEDIUM]
        assert result.learned_suppressions == []


class TestPromptsCarryTheBlock:
    def test_a_multi_pass_review_pass(self, tmp_path, config, monkeypatch):
        _rejections(tmp_path, 3)
        prompts: list[str] = []

        class _Client:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_exc):
                return False

            async def query(self, prompt):
                prompts.append(prompt)

            async def receive_response(self):
                if False:  # an empty answer: no message at all
                    yield None

        # By the module the engine's lazy import will read, not by dotted
        # string: an earlier file that drops `core.client` from `sys.modules`
        # leaves the `core` package pointing at the old module.
        client_module = importlib.import_module("core.client")
        monkeypatch.setattr(
            client_module, "create_agent_client", lambda **_kwargs: _Client()
        )
        engine = PRReviewEngine(tmp_path, tmp_path / ".workpilot" / "github", config)

        findings = asyncio.run(engine.run_review_pass(ReviewPass.QUALITY, _context()))

        assert findings == []
        assert rf.PROMPT_HEADING in prompts[0]
        assert "[style]" in prompts[0]

    def test_a_specialist_reads_the_project_never_the_pr_worktree(
        self, tmp_path, config
    ):
        project = tmp_path / "project"
        worktree = tmp_path / "pr-worktree"
        project.mkdir()
        worktree.mkdir()
        _rejections(project, 3, title="Missing docstring on `foo`")
        # A PR that commits its own dataset tries to silence a security remark.
        _rejections(worktree, 9, title="Hardcoded credential")
        reviewer = ParallelOrchestratorReviewer(
            project_dir=project,
            github_dir=project / ".workpilot" / "github",
            config=config,
        )

        prompt = reviewer._build_specialist_prompt(
            SPECIALIST_CONFIGS[0], _context(), worktree
        )

        assert rf.PROMPT_HEADING in prompt
        assert "Missing docstring" in prompt
        assert "Hardcoded credential" not in prompt


class TestDatasetEdges:
    def test_an_unreadable_dataset_reads_as_empty(self, tmp_path, monkeypatch, caplog):
        _rejections(tmp_path, 3)

        def _denied(_path):
            raise PermissionError("denied")

        monkeypatch.setattr(rf, "_read_tail", _denied)
        with caplog.at_level(logging.WARNING):
            assert rf.load_feedback(tmp_path) == []
        assert "PermissionError" in caplog.text

    def test_blank_lines_are_skipped(self, tmp_path):
        _rejections(tmp_path, 3)
        path = tmp_path / ".workpilot" / "code_review_feedback.jsonl"
        path.write_text(
            "\n\n   \n" + path.read_text(encoding="utf-8"), encoding="utf-8"
        )
        assert len(rf.load_feedback(tmp_path)) == 3

    def test_a_rule_without_reasons_says_none(self):
        rule = rf.LearnedRule("sig", "style", "x", rejections=3)
        assert rule.top_reason is None

    def test_decide_keeps_without_rules_or_below_the_threshold(self):
        assert rf.decide("style", "low", "x", {}) is rf.KEEP
        weak = rf.LearnedRule(rf.signature("style", "x"), "style", "x", rejections=1)
        assert rf.decide("style", "low", "x", {weak.signature: weak}) is rf.KEEP

    def test_the_prompt_block_is_bounded(self, tmp_path, monkeypatch):
        path = tmp_path / ".workpilot" / "code_review_feedback.jsonl"
        path.parent.mkdir(parents=True)
        records = [
            {
                "v": 1,
                "pr": 1000 + n * 10 + i,
                "finding_id": f"k{n}-{i}",
                "verdict": "rejected",
                "reason": None,
                "category": "style",
                "severity": "low",
                "title": f"Remark kind {chr(97 + n)} " + "word " * 15,
            }
            for n in range(5)
            for i in range(3)
        ]
        path.write_text(
            "\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8"
        )
        monkeypatch.setattr(rf, "MAX_PROMPT_CHARS", 250)
        block = rf.prompt_block(tmp_path)
        assert block.count("rejected 3x") == 2


def _bare_orchestrator(project: Path, config) -> orchestrator_module.GitHubOrchestrator:
    orch = orchestrator_module.GitHubOrchestrator.__new__(
        orchestrator_module.GitHubOrchestrator
    )
    orch.project_dir = project
    orch.github_dir = project / ".workpilot" / "github"
    orch.github_dir.mkdir(parents=True, exist_ok=True)
    orch.config = config
    return orch


def _rule(orch, ci_status=None):
    return lambda remaining: orch._generate_verdict(remaining, [], [], ci_status or {})


def _followup(findings, verdict=MergeVerdict.NEEDS_REVISION, blockers=None):
    return PRReviewResult(
        pr_number=5,
        repo="owner/repo",
        success=True,
        findings=findings,
        summary="## Follow-up Review",
        overall_status="request_changes",
        verdict=verdict,
        verdict_reasoning="from the reviewer",
        blockers=list(blockers or []),
        is_followup_review=True,
        unresolved_findings=[f.id for f in findings],
        new_findings_since_last_review=[f.id for f in findings],
    )


class TestFollowupApplies:
    """A follow-up review gets the same suppressions and the initial review's verdict rule."""

    def test_without_feedback_nothing_changes(self, tmp_path, config):
        orch = _bare_orchestrator(tmp_path, config)
        result = _followup([_finding("a", "Missing docstring on `bar`")])
        assert not apply_to_followup(tmp_path, result, _rule(orch))
        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert result.summary == "## Follow-up Review"

    def test_a_failed_or_empty_review_is_left_alone(self, tmp_path, config):
        _rejections(tmp_path, 6)
        orch = _bare_orchestrator(tmp_path, config)
        failed = _followup([_finding("a", "Missing docstring on `bar`")])
        failed.success = False
        assert not apply_to_followup(tmp_path, failed, _rule(orch))
        assert not apply_to_followup(tmp_path, _followup([]), _rule(orch))

    def test_dropping_what_made_it_severe_recomputes_the_verdict(
        self, tmp_path, config
    ):
        _rejections(tmp_path, 6)
        orch = _bare_orchestrator(tmp_path, config)
        result = _followup(
            [_finding("noise", "Missing docstring on `bar`")],
            blockers=["style: Missing docstring on `bar`"],
        )

        assert apply_to_followup(tmp_path, result, _rule(orch))

        assert result.findings == []
        assert [s["id"] for s in result.learned_suppressions] == ["noise"]
        assert result.unresolved_findings == []
        assert result.new_findings_since_last_review == []
        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert result.overall_status == "approve"
        assert result.blockers == []
        assert "Verdict recomputed" in result.summary
        assert "1 finding(s) hidden and 0 downgraded" in result.summary

    def test_a_downgrade_alone_can_relax_it(self, tmp_path, config):
        _rejections(tmp_path, 3)
        orch = _bare_orchestrator(tmp_path, config)
        finding = _finding("lowered", "Missing docstring on `bar`", ReviewSeverity.HIGH)
        result = _followup([finding])

        assert apply_to_followup(tmp_path, result, _rule(orch))

        assert finding.severity == ReviewSeverity.LOW
        assert finding.learned_rejections == 3
        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert "0 finding(s) hidden and 1 downgraded" in result.summary

    def test_pending_ci_keeps_it_out_of_ready(self, tmp_path, config):
        _rejections(tmp_path, 6)
        orch = _bare_orchestrator(tmp_path, config)
        ci = {"pending": 2}
        result = _followup([_finding("noise", "Missing docstring on `bar`")])

        assert apply_to_followup(tmp_path, result, _rule(orch, ci), ci)

        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert "2 check(s) still pending" in result.verdict_reasoning

    def test_a_suppression_never_makes_it_more_severe(self, tmp_path, config):
        _rejections(tmp_path, 6)
        orch = _bare_orchestrator(tmp_path, config)
        # The reviewer let a medium finding through; the rule would not.
        result = _followup(
            [
                _finding("noise", "Missing docstring on `bar`", ReviewSeverity.LOW),
                _finding("real", "Possible None dereference"),
            ],
            verdict=MergeVerdict.READY_TO_MERGE,
        )

        assert apply_to_followup(tmp_path, result, _rule(orch))

        assert result.verdict == MergeVerdict.READY_TO_MERGE
        assert [f.id for f in result.findings] == ["real"]
        assert "Verdict recomputed" not in result.summary

    def test_a_verdict_the_findings_did_not_drive_stands(self, tmp_path, config):
        _rejections(tmp_path, 6)
        orch = _bare_orchestrator(tmp_path, config)
        # Only low findings: the rule says ready either way, the reviewer did not.
        result = _followup(
            [
                _finding("noise", "Missing docstring on `bar`", ReviewSeverity.LOW),
                _finding("other", "Rename this helper", ReviewSeverity.LOW),
            ],
            blockers=[
                "style: Missing docstring on `bar`",
                "Unresolved: Rename this helper (a.py:1)",
            ],
        )

        assert apply_to_followup(tmp_path, result, _rule(orch))

        assert result.verdict == MergeVerdict.NEEDS_REVISION
        assert result.verdict_reasoning == "from the reviewer"
        assert result.blockers == ["Unresolved: Rename this helper (a.py:1)"]

    def test_the_followup_review_saves_it(self, tmp_path, config, monkeypatch):
        _rejections(tmp_path, 6)
        orch = _bare_orchestrator(tmp_path, config)
        orch._jev_worker = None
        orch._report_progress = lambda *a, **k: None
        previous = _followup([])
        previous.is_followup_review = False
        previous.reviewed_commit_sha = "abc123"
        asyncio.run(previous.save(orch.github_dir))

        async def _checks(_number):
            return {}

        orch.gh_client = SimpleNamespace(get_pr_checks_comprehensive=_checks)
        reviewed: list[str] = []
        orch.bot_detector = SimpleNamespace(
            mark_review_started=lambda _n: None,
            mark_review_finished=lambda _n, success=True: None,
            mark_reviewed=lambda _n, sha: reviewed.append(sha),
        )

        class _Gatherer:
            def __init__(self, *_a, **_k):
                pass

            async def gather(self):
                return FollowupReviewContext(
                    pr_number=5,
                    previous_review=previous,
                    previous_commit_sha="abc123",
                    current_commit_sha="def456",
                    commits_since_review=[{"sha": "def456"}],
                )

        class _Reviewer:
            def __init__(self, **_k):
                pass

            async def review_followup(self, _context):
                result = _followup([_finding("noise", "Missing docstring on `bar`")])
                result.reviewed_commit_sha = "def456"
                return result

        async def _nothing(*_a, **_k):
            return None

        context_gatherer = importlib.import_module("runners.github.context_gatherer")
        followup_reviewer = importlib.import_module(
            "runners.github.services.followup_reviewer"
        )
        monkeypatch.setattr(context_gatherer, "FollowupContextGatherer", _Gatherer)
        monkeypatch.setattr(followup_reviewer, "FollowupReviewer", _Reviewer)
        monkeypatch.setattr(orchestrator_module, "observe_with_hermes", _nothing)
        jev_reviews = importlib.import_module("integrations.jev.reviews")
        monkeypatch.setattr(jev_reviews, "evaluate_context", _nothing)
        config.use_parallel_orchestrator = False

        result = asyncio.run(orch.followup_review_pr(5))

        assert result.success, result.error
        assert result.verdict == MergeVerdict.READY_TO_MERGE
        saved = PRReviewResult.load(orch.github_dir, 5)
        assert saved is not None and saved.findings == []
        assert saved.learned_suppressions[0]["id"] == "noise"
        assert reviewed == ["def456"]


class TestFollowupPromptCarriesTheBlock:
    def test_the_parallel_followup_reads_the_project(self, tmp_path, config):
        _rejections(tmp_path, 3)
        reviewer = ParallelFollowupReviewer(
            project_dir=tmp_path,
            github_dir=tmp_path / ".workpilot" / "github",
            config=config,
        )
        previous = _followup([])
        context = FollowupReviewContext(
            pr_number=5,
            previous_review=previous,
            previous_commit_sha="abc12345",
            current_commit_sha="def45678",
        )

        prompt = reviewer._build_orchestrator_prompt(context)

        assert rf.PROMPT_HEADING in prompt
        assert "Missing docstring" in prompt
