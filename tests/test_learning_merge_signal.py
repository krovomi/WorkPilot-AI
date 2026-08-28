"""Tests for the merge verdict reaching the learning loop.

`ExternalSignal.PR_MERGED` was declared, handled by `signals_from_outcome`, and
never once written — the observe phase runs when the build ends, and nobody has
merged anything yet. `record_merge_outcome` is the late path that fixes that.

What matters here is not that it writes, but that it cannot over-credit: a
merge is the strongest corroboration in the set, so a webhook redelivery that
counted twice would promote patterns the thresholds meant to hold back.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from learning_loop.observe import record_merge_outcome  # noqa: E402
from learning_loop.skill_proposer import (  # noqa: E402
    ExternalSignal,
    LedgerKey,
    ledger_path,
    record_outcome,
    record_signal_for_build,
)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """A repo root with one ledger crediting build 001 for two patterns."""
    key = LedgerKey("code-reviewer", "python", "feature-build")
    record_outcome(tmp_path, key, "pattern-a", ExternalSignal.TESTS_PASSED, "001")
    record_outcome(tmp_path, key, "pattern-b", ExternalSignal.TESTS_PASSED, "001")
    record_outcome(tmp_path, key, "pattern-c", ExternalSignal.TESTS_PASSED, "002")
    return tmp_path


def _entry(repo: Path, pattern_id: str) -> dict:
    key = LedgerKey("code-reviewer", "python", "feature-build")
    data = json.loads(ledger_path(repo, key).read_text(encoding="utf-8"))
    return data[pattern_id]


class TestCrediting:
    def test_every_pattern_the_build_fed_is_credited(self, repo: Path):
        assert record_signal_for_build(repo, "001", ExternalSignal.PR_MERGED) == 2
        assert ExternalSignal.PR_MERGED.value in _entry(repo, "pattern-a")["signals"]
        assert ExternalSignal.PR_MERGED.value in _entry(repo, "pattern-b")["signals"]

    def test_a_pattern_from_another_build_is_untouched(self, repo: Path):
        record_signal_for_build(repo, "001", ExternalSignal.PR_MERGED)
        assert (
            ExternalSignal.PR_MERGED.value not in _entry(repo, "pattern-c")["signals"]
        )

    def test_the_existing_signals_survive(self, repo: Path):
        record_signal_for_build(repo, "001", ExternalSignal.PR_MERGED)
        assert ExternalSignal.TESTS_PASSED.value in _entry(repo, "pattern-a")["signals"]


class TestCannotOverCredit:
    def test_a_redelivered_merge_counts_once(self, repo: Path):
        """A webhook that fires twice must not double the corroboration."""
        assert record_signal_for_build(repo, "001", ExternalSignal.PR_MERGED) == 2
        assert record_signal_for_build(repo, "001", ExternalSignal.PR_MERGED) == 0
        signals = _entry(repo, "pattern-a")["signals"]
        assert signals.count(ExternalSignal.PR_MERGED.value) == 1

    def test_a_different_build_still_credits(self, repo: Path):
        record_signal_for_build(repo, "001", ExternalSignal.PR_MERGED)
        assert record_signal_for_build(repo, "002", ExternalSignal.PR_MERGED) == 1


class TestDegradation:
    def test_no_ledgers_is_zero_not_an_error(self, tmp_path: Path):
        assert record_merge_outcome(tmp_path, "001") == 0

    def test_an_unknown_build_credits_nothing(self, repo: Path):
        assert record_merge_outcome(repo, "does-not-exist") == 0

    def test_a_corrupt_ledger_is_skipped_not_raised(self, repo: Path):
        key = LedgerKey("code-reviewer", "python", "feature-build")
        bad = ledger_path(repo, key).parent / "broken.json"
        bad.write_text("{ not json", encoding="utf-8")
        # The good ledger is still credited.
        assert record_merge_outcome(repo, "001") == 2

    def test_public_entry_point_matches_the_helper(self, repo: Path):
        assert record_merge_outcome(repo, "001") == 2
