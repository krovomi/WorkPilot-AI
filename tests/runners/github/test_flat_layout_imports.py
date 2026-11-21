"""The GitHub runner's modules load under the runner's own flat layout.

`runner.py` puts `apps/backend` and then its own folder first on `sys.path`,
so the orchestrator and the reviewers import their neighbours by bare name
(`models`, `providers`, `services.category_utils`...), while the backend's
API imports the same files as `runners.github.*`. Each module carries both
imports; the tests elsewhere load the package one. This one starts Python the
way the runner lays the path out and loads the bare one, in a fresh process so
the backend's own `services` package is not already taken.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from tests.gh_fake import write_fake_gh

BACKEND = Path(__file__).resolve().parents[3] / "apps" / "backend"

PROGRAM = """
import sys
sys.path.insert(0, {backend!r})
sys.path.insert(0, {runner!r})

import models
import providers
from services import autofix_processor, category_utils, prompt_manager
from services import response_parsers, triage_engine

assert providers.GitHubProvider.__module__ == "providers.github_provider"
assert category_utils.map_category("logic") is models.ReviewCategory.QUALITY
assert prompt_manager.PromptManager().get_review_pass_prompt(models.ReviewPass.SECURITY)
parsed = response_parsers.ResponseParser.parse_triage_result(
    {{"number": 3}}, '```json\\n{{"category": "bug"}}\\n```', "o/r"
)
assert parsed.category is models.TriageCategory.BUG
assert triage_engine.TriageEngine.__name__ == "TriageEngine"
assert autofix_processor.AutoFixProcessor.__name__ == "AutoFixProcessor"
print("flat layout ok")
"""


def test_every_module_imports_by_bare_name_as_the_runner_does():
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
    env.update({"PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"})
    done = subprocess.run(
        [
            sys.executable,
            "-c",
            PROGRAM.format(
                backend=str(BACKEND), runner=str(BACKEND / "runners" / "github")
            ),
        ],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )
    assert done.returncode == 0, done.stderr
    assert "flat layout ok" in done.stdout


ORCHESTRATION = """
import asyncio
import sys
from pathlib import Path
from types import ModuleType

sys.path.insert(0, {backend!r})
sys.path.insert(0, {runner!r})
work = Path({work!r})
github_dir = work / ".workpilot" / "github"

import batch_issues
from services import batch_processor
from models import GitHubRunnerConfig

assert batch_issues.BatchValidator.__module__ == "batch_validator"
config = GitHubRunnerConfig(token="placeholder", repo="own/repo")
events = []
processor = batch_processor.BatchProcessor(work, github_dir, config, events.append)

# The first progress event loads the runner's own orchestrator for its
# ProgressCallback; the next ones reuse it.
assert "orchestrator" not in sys.modules
approved = [{{"primary_issue": 1, "issues": [{{"issue_number": 1, "title": "A"}}]}}]
created = asyncio.run(processor.approve_and_execute_batches(approved))
assert [b.primary_issue for b in created] == [1]
assert type(events[0]).__module__ == "orchestrator"
assert asyncio.run(processor.batch_and_fix_issues([], None)) == []
assert asyncio.run(processor.analyze_issues_preview([]))["total_issues"] == 0
assert asyncio.run(processor.get_batch_status())["total_batches"] == 1
assert asyncio.run(processor.process_pending_batches()) == 0

# A follow-up review, with the gatherer and the reviewers standing in.
import context_gatherer
import orchestrator
import services.followup_reviewer
from runners.github.models import FollowupReviewContext, PRReviewResult


async def nothing(*_args, **_kwargs):
    return None


orchestrator.observe_with_hermes = nothing


class Gatherer:
    def __init__(self, project_dir, pr_number, previous_review, repo=None):
        self.previous_review = previous_review

    async def gather(self):
        return FollowupReviewContext(
            pr_number=5,
            previous_review=self.previous_review,
            previous_commit_sha="aaa111",
            current_commit_sha="bbb222",
            commits_since_review=[{{"oid": "bbb222"}}],
        )


class Reviewer:
    def __init__(self, **built):
        self.name = "sequential"

    async def _review(self, _context):
        return PRReviewResult(
            pr_number=5, repo="own/repo", success=True, summary=self.name,
            reviewed_commit_sha="bbb222",
        )

    review = review_followup = _review


class Parallel(Reviewer):
    def __init__(self, **built):
        self.name = "parallel"


context_gatherer.FollowupContextGatherer = Gatherer
services.followup_reviewer.FollowupReviewer = Reviewer
parallel = ModuleType("services.parallel_followup_reviewer")
parallel.ParallelFollowupReviewer = Parallel
sys.modules[parallel.__name__] = parallel

for use_parallel, expected in ((False, "sequential"), (True, "parallel")):
    asyncio.run(
        PRReviewResult(
            pr_number=5, repo="own/repo", success=True, reviewed_commit_sha="aaa111"
        ).save(github_dir)
    )
    orch = orchestrator.GitHubOrchestrator(
        work,
        GitHubRunnerConfig(
            token="placeholder", repo="own/repo", use_parallel_orchestrator=use_parallel
        ),
    )
    result = asyncio.run(orch.followup_review_pr(5))
    assert result.summary == expected, (result.summary, result.error)
print("flat orchestration ok")
"""


def test_the_orchestrator_and_the_batch_steps_run_under_the_runner_layout(tmp_path):
    """`runner.py` loads `orchestrator`, `batch_issues` and the batch processor
    by bare name; each lazy import inside them takes the same road."""
    gh = write_fake_gh(tmp_path / "gh", {"--version": {"stdout": "gh 2.80.0\n"}})
    env = {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME")}
    env.update(
        {
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "GITHUB_CLI_PATH": str(gh.path),
            "HERMES_HOME": str(tmp_path / "no-hermes"),
            "WORKPILOT_BRAIN_DIR": str(tmp_path / "no-brain"),
        }
    )
    done = subprocess.run(
        [
            sys.executable,
            "-c",
            ORCHESTRATION.format(
                backend=str(BACKEND),
                runner=str(BACKEND / "runners" / "github"),
                work=str(tmp_path / "project"),
            ),
        ],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=180,
    )
    assert done.returncode == 0, done.stderr
    assert "flat orchestration ok" in done.stdout
