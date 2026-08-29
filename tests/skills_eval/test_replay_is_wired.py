"""The replay gate, reached the way a real build reaches it.

`test_replay_gate.py` proves the comparison arithmetic and `test_observe_phase`
proves the veto works when a `ReplayResult` is handed in. Neither exercised the
path that matters in production: `run_observe` was only ever called with
`replay=None`, so nothing ever built one, and `RejectionReason.REPLAY_REGRESSION`
could not occur outside a test that constructed it by hand.

These tests call `run_observe` exactly as `cli/build_commands.py` does — no
replay argument — against a repo holding the real golden corpus, and check that
a candidate which drops what an episode discriminates on is refused.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.models import (  # noqa: E402
    LearningPattern,
    PatternCategory,
    PatternSource,
    PatternType,
)
from learning_loop.observe import (  # noqa: E402
    GOLDEN_RELPATH,
    BuildOutcome,
    baseline_instruction,
    golden_corpus,
    run_observe,
)
from learning_loop.replay import DISCRIMINATOR  # noqa: E402
from learning_loop.skill_proposer import RejectionReason  # noqa: E402

# What today's `test-runner` instruction carries. A candidate keeping these is
# measured clean; one dropping any of them regresses the episode that names it.
KEEPS_EVERYTHING = (
    "Parse the output rather than its tail. Report each finding with its file "
    "path and line number. Use dotnet test --filter to iterate on one test. "
    "Re-run a suspected flaky test before reporting it. Name any untested "
    "acceptance criterion."
)
DROPS_THE_FILTER = KEEPS_EVERYTHING.replace(
    "Use dotnet test --filter to iterate on one test. ", ""
)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repo root carrying the real corpus, so the gate has something to grade."""
    destination = tmp_path / GOLDEN_RELPATH
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(REPO_ROOT / GOLDEN_RELPATH, destination)
    return tmp_path


def _pattern(instruction: str) -> LearningPattern:
    return LearningPattern(
        pattern_id="p-test-runner",
        category=PatternCategory.QA_PATTERN,
        pattern_type=PatternType.SUCCESS,
        source=PatternSource.BUILD_ANALYSIS,
        description="how to run tests here",
        confidence=0.9,
        occurrence_count=5,
        agent_phase="coding",  # files to code-reviewer and test-runner
        context_tags=["python"],
        actionable_instruction=instruction,
    )


def _outcome(spec_id: str) -> BuildOutcome:
    return BuildOutcome(
        spec_id=spec_id,
        qa_approved=True,
        tests_passed=True,
        language="python",
        workflow="feature-build",
    )


def _observe_until_promotion(repo: Path, instruction: str):
    """Three corroborated builds — the point where the replay is consulted."""
    reports = [
        run_observe(repo, _outcome(f"spec-{i}"), [_pattern(instruction)])
        for i in range(3)
    ]
    return reports


class TestTheCorpusIsReachable:
    def test_the_fixture_repo_exposes_the_real_episodes(self, repo: Path):
        assert golden_corpus(repo, "test-runner")

    def test_todays_instruction_satisfies_every_passing_episode(self):
        """If this breaks, a real build starts reporting false regressions."""
        base = baseline_instruction("test-runner").lower()
        for episode in golden_corpus(REPO_ROOT, "test-runner"):
            satisfied = all(
                r.lower() in base for r in episode.context.get("requires", [])
            )
            assert satisfied == episode.baseline_passed, (
                f"{episode.episode_id}: the recorded verdict and the "
                "discriminator disagree, so the gate is measuring the wrong thing"
            )


class TestTheGateRunsWithoutBeingHandedOne:
    def test_a_replay_is_built_when_none_is_passed(self, repo: Path):
        reports = _observe_until_promotion(repo, KEEPS_EVERYTHING)
        assert any(r.replay is not None and r.replay.ran for r in reports), (
            "run_observe never built a replay — the gate is unreachable again"
        )

    def test_it_records_how_it_measured(self, repo: Path):
        reports = _observe_until_promotion(repo, KEEPS_EVERYTHING)
        measured = [r.replay for r in reports if r.replay is not None]
        assert measured and measured[0].method == DISCRIMINATOR

    def test_no_corpus_means_no_replay_and_no_veto(self, tmp_path: Path):
        """A project without golden episodes must still be able to promote."""
        reports = _observe_until_promotion(tmp_path, DROPS_THE_FILTER)
        assert all(r.replay is None for r in reports)
        assert any(r.proposals_written for r in reports)


class TestTheVeto:
    def test_dropping_a_discriminator_blocks_the_promotion(self, repo: Path):
        """The veto is per agent, and only the agent that regressed is stopped.

        A `coding` pattern is filed against `code-reviewer` and `test-runner`.
        Dropping `--filter` breaks `test-runner/dotnet-single-test` and nothing
        the code reviewer is graded on, so that half must still promote —
        blocking both would make one agent's regression everyone else's.
        """
        reports = _observe_until_promotion(repo, DROPS_THE_FILTER)
        written = [p.name for r in reports for p in r.proposals_written]

        assert not [n for n in written if n.startswith("test-runner")], (
            f"test-runner regressed an episode and was proposed anyway: {written}"
        )
        assert [n for n in written if n.startswith("code-reviewer")], (
            "the code reviewer broke nothing and must still be proposed"
        )
        assert RejectionReason.REPLAY_REGRESSION in {
            reason for report in reports for _, reason in report.rejected
        }

    def test_keeping_them_promotes(self, repo: Path):
        reports = _observe_until_promotion(repo, KEEPS_EVERYTHING)
        written = [p for r in reports for p in r.proposals_written]
        assert written, "a candidate that regresses nothing must still promote"

    def test_the_proposal_says_what_was_measured(self, repo: Path):
        reports = _observe_until_promotion(repo, KEEPS_EVERYTHING)
        written = [p for r in reports for p in r.proposals_written]
        body = written[0].read_text(encoding="utf-8")
        assert DISCRIMINATOR in body, (
            "the proposal must name the grading method — a text check and a "
            "live re-run must not read identically"
        )


class TestDegradation:
    def test_an_empty_candidate_instruction_skips_the_replay(self, repo: Path):
        reports = _observe_until_promotion(repo, "")
        assert all(r.replay is None for r in reports)

    def test_an_unknown_agent_has_no_baseline(self):
        assert baseline_instruction("not-an-agent") == ""
