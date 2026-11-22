"""The CI's verdict on a PR as it was opened, kept once in `pr_followup.json`
for "How you compare" (first-run CI pass rate). A fake forge stands in for
GitHub: nothing here reaches a network.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest
from pr_followup.loop import run_round
from pr_followup.model import Check, CheckState, PRSnapshot
from pr_followup.policy import first_ci_verdict
from pr_followup.state import FollowupState, load_state, save_state

URL = "https://github.com/acme/app/pull/7"


def _snap(*checks: Check, head: str = "a" * 40, **kw) -> PRSnapshot:
    return PRSnapshot(
        url=URL, number=7, head_sha=head, base_branch="main", checks=checks, **kw
    )


PASSED = Check("unit", CheckState.PASSED)
FAILED = Check("unit", CheckState.FAILED)
LINT_FAILED = Check("lint", CheckState.FAILED)
PENDING = Check("e2e", CheckState.PENDING)


@pytest.mark.parametrize(
    ("snapshot", "base", "expected"),
    [
        # Nothing to judge yet, or nothing the CI said of this PR.
        (_snap(PASSED, error="gh: rate limited"), frozenset(), ""),
        (_snap(PASSED, state="MERGED"), frozenset(), ""),
        (_snap(), frozenset(), ""),
        (_snap(PASSED, PENDING), frozenset(), ""),
        # Red on the base branch too: not the PR's verdict.
        (_snap(PASSED, LINT_FAILED), frozenset({"lint"}), ""),
        (_snap(PASSED), frozenset(), "passed"),
        (_snap(PASSED, Check("docs", CheckState.PASSED)), None, "passed"),
        (_snap(FAILED, LINT_FAILED), frozenset({"lint"}), "failed"),
        # The base could not be read: every failure is the PR's own.
        (_snap(LINT_FAILED), None, "failed"),
    ],
)
def test_the_first_verdict_waits_for_every_check_of_the_pr(snapshot, base, expected):
    assert first_ci_verdict(snapshot, base) == expected


def test_the_verdict_is_kept_and_a_stray_value_is_dropped(tmp_path):
    state = FollowupState(first_ci="failed")
    save_state(tmp_path, state)
    assert load_state(tmp_path).first_ci == "failed"
    raw = json.loads((tmp_path / "pr_followup.json").read_text(encoding="utf-8"))
    for stray in ("green", 1, None):
        raw["first_ci"] = stray
        (tmp_path / "pr_followup.json").write_text(json.dumps(raw), encoding="utf-8")
        assert load_state(tmp_path).first_ci == ""


class FakeForge:
    """A forge that answers with the snapshots it is given, one per look."""

    def __init__(self, *snaps: PRSnapshot) -> None:
        self.snaps = list(snaps)

    async def snapshot(self) -> PRSnapshot:
        return self.snaps.pop(0)

    async def base_failing_names(self, base_branch: str) -> frozenset[str] | None:
        return frozenset()

    async def failed_log(self, check: Check) -> str:
        return "E   AssertionError"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


def _repo(tmp_path: Path) -> tuple[Path, Path, str]:
    repo = tmp_path / "wt"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "t")
    (repo / "app.py").write_text("def total():\n    return 1\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "init")
    spec = tmp_path / "spec"
    spec.mkdir()
    return repo, spec, _git(repo, "rev-parse", "HEAD")


async def _round(spec: Path, repo: Path, forge: FakeForge, fixer=None):
    async def no_fixer(worktree: Path, spec_dir: Path, session: int):
        raise AssertionError("no fix round expected")

    return await run_round(
        spec_dir=spec,
        worktree_dir=repo,
        forge=forge,
        fixer=fixer or no_fixer,
        pusher=lambda: (True, ""),
    )


async def test_the_first_verdict_is_recorded_once_then_kept(tmp_path):
    repo, spec, head = _repo(tmp_path)
    # Still running: nothing recorded.
    await _round(spec, repo, FakeForge(_snap(PENDING, head=head)))
    assert load_state(spec).first_ci == ""

    async def fixer(worktree: Path, spec_dir: Path, session: int):
        (worktree / "app.py").write_text("def total():\n    return 2\n", "utf-8")
        _git(worktree, "commit", "-qam", "fix")
        return "fixed", "done"

    # Red as opened: "failed", whatever the fix makes of it afterwards.
    await _round(spec, repo, FakeForge(_snap(FAILED, head=head)), fixer)
    assert load_state(spec).first_ci == "failed"
    fixed = _git(repo, "rev-parse", "HEAD")
    await _round(spec, repo, FakeForge(_snap(PASSED, head=fixed)))
    assert load_state(spec).first_ci == "failed"


async def test_a_verdict_after_a_fix_round_is_not_the_first_run(tmp_path):
    repo, spec, head = _repo(tmp_path)
    save_state(spec, FollowupState(rounds=1))
    await _round(spec, repo, FakeForge(_snap(PASSED, head=head)))
    assert load_state(spec).first_ci == ""


async def test_a_pr_green_as_opened_passed_the_first_run(tmp_path):
    repo, spec, head = _repo(tmp_path)
    await _round(spec, repo, FakeForge(_snap(PASSED, head=head)))
    assert load_state(spec).first_ci == "passed"
