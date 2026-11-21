"""The GitHub reviewers read the project they review, and nothing above it.

A project folder named ``backend`` is handed to the agent as it is: every
reviewer (the multi-pass engine, the parallel orchestrator and the parallel
follow-up) passes the project directory itself as the agent's ``project_dir``.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import sys
from pathlib import Path

import pytest

# The parallel reviewers import their siblings by bare name, as the GitHub
# runner starts them: same set-up as tests/test_review_feedback_wiring.py.
_GITHUB_DIR = (
    Path(__file__).resolve().parents[3] / "apps" / "backend" / "runners" / "github"
)
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

import runners.github.services.parallel_followup_reviewer as followup_module  # noqa: E402
import runners.github.services.parallel_orchestrator_reviewer as orchestrator_module  # noqa: E402
from runners.github.context_gatherer import (  # noqa: E402
    AIBotComment,
    ChangedFile,
    PRContext,
)
from runners.github.models import (  # noqa: E402
    FollowupReviewContext,
    GitHubRunnerConfig,
    PRReviewResult,
    ReviewPass,
)
from runners.github.services.pr_review_engine import PRReviewEngine  # noqa: E402


class _Stop(Exception):
    """Raised by the fake factory once it has seen the project_dir."""


@pytest.fixture
def config() -> GitHubRunnerConfig:
    return GitHubRunnerConfig(token="test-token-0000", repo="owner/repo")


@pytest.fixture
def project(tmp_path) -> Path:
    path = tmp_path / "apps" / "backend"
    path.mkdir(parents=True)
    return path


def _context(**overrides) -> PRContext:
    values = {
        "pr_number": 5,
        "title": "Add a feature",
        "description": "body",
        "author": "someone",
        "base_branch": "develop",
        "head_branch": "",
        "state": "open",
        "changed_files": [
            ChangedFile("a.py", "modified", 3, 1, "", "", "@@ -1 +1 @@\n-x\n+y")
        ],
        "diff": "@@ -1 +1 @@\n-x\n+y",
        "repo_structure": "",
        "related_files": [],
    }
    values.update(overrides)
    return PRContext(**values)


class _Client:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc):
        return False

    async def query(self, _prompt):
        return None

    async def receive_response(self):
        if False:  # an empty answer: no message at all
            yield None


class TestMultiPassEngine:
    @pytest.fixture
    def seen(self, monkeypatch) -> list[Path]:
        seen: list[Path] = []

        def factory(**kwargs):
            seen.append(Path(kwargs["project_dir"]))
            return _Client()

        client_module = importlib.import_module("core.client")
        monkeypatch.setattr(client_module, "create_agent_client", factory)
        return seen

    def test_a_review_pass_reads_the_project_itself(self, project, config, seen):
        engine = PRReviewEngine(project, project / ".workpilot" / "github", config)
        asyncio.run(engine.run_review_pass(ReviewPass.QUALITY, _context()))
        assert seen == [project]

    def test_the_structural_pass_reads_the_project_itself(self, project, config, seen):
        engine = PRReviewEngine(project, project / ".workpilot" / "github", config)
        asyncio.run(engine._run_structural_pass(_context()))
        assert seen == [project]

    def test_the_comment_triage_pass_reads_the_project_itself(
        self, project, config, seen
    ):
        engine = PRReviewEngine(project, project / ".workpilot" / "github", config)
        comment = AIBotComment(
            comment_id=1,
            author="bot",
            tool_name="CodeRabbit",
            body="Consider a guard here.",
            file="a.py",
            line=1,
            created_at="2026-11-01T00:00:00Z",
        )
        asyncio.run(engine._run_ai_triage_pass(_context(ai_bot_comments=[comment])))
        assert seen == [project]


class TestParallelOrchestrator:
    def _reviewer(self, project, config, monkeypatch, seen):
        reviewer = orchestrator_module.ParallelOrchestratorReviewer(
            project_dir=project,
            github_dir=project / ".workpilot" / "github",
            config=config,
        )

        async def specialists(*, context, project_root, model, thinking_budget):
            seen.append(Path(project_root))
            raise _Stop

        monkeypatch.setattr(reviewer, "_cleanup_stale_pr_worktrees", lambda: None)
        monkeypatch.setattr(reviewer, "_run_parallel_specialists", specialists)
        return reviewer

    def test_without_a_head_commit_it_reads_the_project_itself(
        self, project, config, monkeypatch
    ):
        seen: list[Path] = []
        reviewer = self._reviewer(project, config, monkeypatch, seen)

        result = asyncio.run(reviewer.review(_context(head_sha="", head_branch="")))

        assert seen == [project]
        assert result.success is False

    def test_when_the_worktree_fails_it_reads_the_project_itself(
        self, project, config, monkeypatch
    ):
        seen: list[Path] = []
        reviewer = self._reviewer(project, config, monkeypatch, seen)

        def no_worktree(_sha, _number):
            raise RuntimeError("no worktree")

        monkeypatch.setattr(reviewer, "_create_pr_worktree", no_worktree)

        asyncio.run(reviewer.review(_context(head_sha="abc1234")))

        assert seen == [project]


class TestParallelFollowup:
    def test_without_a_valid_head_commit_it_reads_the_project_itself(
        self, project, config, monkeypatch
    ):
        seen: list[Path] = []

        def factory(**kwargs):
            seen.append(Path(kwargs["project_dir"]))
            raise _Stop

        monkeypatch.setattr(followup_module, "create_agent_client", factory)
        reviewer = followup_module.ParallelFollowupReviewer(
            project_dir=project,
            github_dir=project / ".workpilot" / "github",
            config=config,
        )
        monkeypatch.setattr(reviewer, "_build_orchestrator_prompt", lambda _c: "p")
        previous = PRReviewResult(pr_number=5, repo="owner/repo", success=True)
        context = FollowupReviewContext(
            pr_number=5,
            previous_review=previous,
            previous_commit_sha="",
            current_commit_sha="",
        )

        asyncio.run(reviewer.review(context))

        assert seen == [project]


class TestIssueTriage:
    def test_an_issue_is_triaged_by_the_read_only_triage_agent(
        self, project, config, monkeypatch
    ):
        from runners.github.services.triage_engine import TriageEngine

        seen: list[dict] = []

        def factory(**kwargs):
            seen.append(kwargs)
            return _Client()

        client_module = importlib.import_module("core.client")
        monkeypatch.setattr(client_module, "create_agent_client", factory)
        engine = TriageEngine(project, project / ".workpilot" / "github", config)
        issue = {
            "number": 3,
            "title": "Crash on start",
            "body": "It crashes.",
            "author": {"login": "someone"},
            "createdAt": "2026-11-01T00:00:00Z",
            "labels": [],
        }

        asyncio.run(engine.triage_single_issue(issue, [issue]))

        assert [call["agent_type"] for call in seen] == ["issue_triage"]
        assert Path(seen[0]["project_dir"]) == project
