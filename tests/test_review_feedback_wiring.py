"""Where the learned suppressions meet the PR review (#361).

The rules themselves are tested in ``test_review_feedback_learning.py``; here,
that the review applies them after it ran, whatever the model did, and that
each reviewer's prompt gets the block — read from the project, never from the
PR's worktree.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

# The parallel reviewer imports its siblings by bare name (`context_gatherer`,
# `services.agent_utils`…), as the GitHub runner starts it. Same set-up as
# tests/test_copilot_integration.py: the folder appended, never prepended (its
# `services/` would shadow apps/backend/services), its services preloaded.
_BACKEND = Path(__file__).parent.parent / "apps" / "backend"
_GITHUB_DIR = _BACKEND / "runners" / "github"
if str(_GITHUB_DIR) not in sys.path:
    sys.path.append(str(_GITHUB_DIR))
for _name in (
    "agent_utils",
    "category_utils",
    "io_utils",
    "pydantic_models",
    "pr_worktree_manager",
    "sdk_utils",
):
    if f"services.{_name}" not in sys.modules:
        _spec = importlib.util.spec_from_file_location(
            f"services.{_name}",
            _GITHUB_DIR / "services" / f"{_name}.py",
            submodule_search_locations=[],
        )
        _module = importlib.util.module_from_spec(_spec)
        sys.modules[f"services.{_name}"] = _module
        _spec.loader.exec_module(_module)

import runners.github.orchestrator as orchestrator_module  # noqa: E402
from learning_loop import review_feedback as rf  # noqa: E402
from runners.github.context_gatherer import ChangedFile, PRContext  # noqa: E402
from runners.github.models import (  # noqa: E402
    GitHubRunnerConfig,
    PRReviewFinding,
    PRReviewResult,
    ReviewCategory,
    ReviewPass,
    ReviewSeverity,
)
from runners.github.services.parallel_orchestrator_reviewer import (  # noqa: E402
    SPECIALIST_CONFIGS,
    ParallelOrchestratorReviewer,
)
from runners.github.services.pr_review_engine import PRReviewEngine  # noqa: E402


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
        monkeypatch.setattr("integrations.jev.reviews.evaluate_context", _nothing)
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

        monkeypatch.setattr(
            "core.client.create_agent_client", lambda **_kwargs: _Client()
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
