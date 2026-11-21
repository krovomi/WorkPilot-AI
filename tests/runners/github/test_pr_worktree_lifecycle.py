"""The PR review worktrees: one checkout per reviewed commit, cleaned up behind.

A PR review reads the code at the PR's head in a worktree of its own
(runners/github/services/pr_worktree_manager.py). Left alone they would fill
the disk, so the manager removes the orphaned ones (no longer known to git),
the expired ones and the oldest beyond a count, and falls back to deleting the
folder when git cannot. These tests use a real repository with a local
`origin`; a git that hangs is simulated by failing one command with the
timeout `subprocess.run` raises.
"""

from __future__ import annotations

import os
import subprocess
import time
import types
from pathlib import Path

import pytest
from runners.github.services import pr_worktree_manager as manager_module
from runners.github.services.pr_worktree_manager import PRWorktreeManager


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path, monkeypatch):
    for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        monkeypatch.delenv(var, raising=False)
    for var, value in {
        "GIT_AUTHOR_NAME": "T",
        "GIT_AUTHOR_EMAIL": "t@example.com",
        "GIT_COMMITTER_NAME": "T",
        "GIT_COMMITTER_EMAIL": "t@example.com",
        "GIT_CEILING_DIRECTORIES": str(tmp_path),
        "GIT_CONFIG_NOSYSTEM": "1",
        "HOME": str(tmp_path),
    }.items():
        monkeypatch.setenv(var, value)
    monkeypatch.delenv("MAX_PR_WORKTREES", raising=False)
    monkeypatch.delenv("PR_WORKTREE_MAX_AGE_DAYS", raising=False)
    origin = tmp_path / "origin.git"
    git(tmp_path, "init", "--bare", str(origin))
    root = tmp_path / "project"
    root.mkdir()
    git(root, "init", "--initial-branch=main")
    git(root, "remote", "add", "origin", str(origin))
    (root / "app.py").write_text("print('hi')\n", encoding="utf-8")
    git(root, "add", ".")
    git(root, "commit", "-m", "first")
    git(root, "push", "origin", "main")
    return root


@pytest.fixture
def manager(repo):
    return PRWorktreeManager(repo, ".workpilot/pr-worktrees")


def head(repo: Path) -> str:
    return git(repo, "rev-parse", "HEAD")


def hang(monkeypatch, *argv: str) -> None:
    """Make the git command starting with `argv` time out; the rest run."""
    real_run = subprocess.run

    def run(cmd, *args, **kwargs):
        if cmd[: len(argv)] == list(argv):
            raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))
        return real_run(cmd, *args, **kwargs)

    monkeypatch.setattr(
        manager_module,
        "subprocess",
        types.SimpleNamespace(run=run, TimeoutExpired=subprocess.TimeoutExpired),
    )


def age(path: Path, days: float) -> None:
    then = time.time() - days * 86400
    os.utime(path, (then, then))


def test_a_review_checks_out_the_pr_head_in_its_own_worktree(manager, repo):
    sha = head(repo)
    path = manager.create_worktree(sha, 12, auto_cleanup=False)
    assert path.name.startswith(f"pr-12-{sha[:8]}-")
    assert (path / "app.py").is_file()
    assert git(path, "rev-parse", "HEAD") == sha
    assert path.resolve() in {p.resolve() for p in manager.get_registered_worktrees()}
    assert manager.get_worktree_info()[0].pr_number == 12


@pytest.mark.parametrize(
    ("sha", "pr_number", "message"),
    [
        ("", 1, "Invalid head_sha"),
        ("abc; rm -rf /", 1, "Invalid head_sha"),
        ("abc123", 0, "Invalid pr_number"),
        ("abc123", "7", "Invalid pr_number"),
    ],
)
def test_a_bad_commit_or_pr_number_is_refused_before_git(
    manager, sha, pr_number, message
):
    with pytest.raises(ValueError, match=message):
        manager.create_worktree(sha, pr_number)
    assert not manager.worktree_base_dir.exists()


def test_a_commit_that_does_not_exist_leaves_nothing_behind(manager, caplog):
    with pytest.raises(RuntimeError, match="Failed to create worktree"):
        manager.create_worktree("deadbeef" * 5, 3, auto_cleanup=False)
    assert "Could not fetch" in caplog.text
    assert list(manager.worktree_base_dir.iterdir()) == []


def test_a_fetch_that_hangs_does_not_stop_the_review(
    manager, repo, monkeypatch, caplog
):
    hang(monkeypatch, "git", "fetch")
    path = manager.create_worktree(head(repo), 4, auto_cleanup=False)
    assert path.is_dir()
    assert "Timeout fetching" in caplog.text


def test_a_checkout_that_hangs_fails_the_review_and_cleans_up(
    manager, repo, monkeypatch
):
    hang(monkeypatch, "git", "worktree", "add")
    with pytest.raises(RuntimeError, match="Timeout creating worktree"):
        manager.create_worktree(head(repo), 4, auto_cleanup=False)
    assert list(manager.worktree_base_dir.iterdir()) == []


def test_creating_first_clears_out_the_old_ones(manager, repo, monkeypatch):
    monkeypatch.setenv("MAX_PR_WORKTREES", "1")
    first = manager.create_worktree(head(repo), 1, auto_cleanup=False)
    second = manager.create_worktree(head(repo), 2, auto_cleanup=False)
    age(first, 1)
    third = manager.create_worktree(head(repo), 3)
    assert not first.exists()
    assert second.is_dir() and third.is_dir()


def test_removing_something_that_is_not_there_does_nothing(manager, tmp_path):
    manager.remove_worktree(None)
    manager.remove_worktree(tmp_path / "gone")


def test_a_folder_git_does_not_know_is_deleted_anyway(manager, caplog):
    stray = manager.worktree_base_dir / "pr-9-stray"
    stray.mkdir(parents=True)
    manager.remove_worktree(stray)
    assert not stray.exists()
    assert "Used shutil fallback for: pr-9-stray" in caplog.text


def test_a_remove_that_hangs_falls_back_to_deleting(manager, repo, monkeypatch, caplog):
    path = manager.create_worktree(head(repo), 5, auto_cleanup=False)
    hang(monkeypatch, "git", "worktree", "remove")
    manager.remove_worktree(path)
    assert not path.exists()
    assert "falling back to shutil" in caplog.text


def test_a_fallback_whose_prune_hangs_is_logged(manager, monkeypatch, caplog):
    stray = manager.worktree_base_dir / "pr-9-stray"
    stray.mkdir(parents=True)
    hang(monkeypatch, "git", "worktree", "prune")
    manager.remove_worktree(stray)
    assert not stray.exists()
    assert "Failed to remove worktree" in caplog.text


def test_folder_names_give_the_pr_number_when_they_hold_one(manager):
    base = manager.worktree_base_dir
    for name in ("pr-31-abc-1", "pr-abc", "pr-", "scratch"):
        (base / name).mkdir(parents=True)
    (base / "notes.txt").write_text("not a worktree", encoding="utf-8")
    numbers = {info.path.name: info.pr_number for info in manager.get_worktree_info()}
    assert numbers == {"pr-31-abc-1": 31, "pr-abc": None, "pr-": None, "scratch": None}


def test_a_listing_that_hangs_knows_no_worktree(manager, monkeypatch, caplog):
    hang(monkeypatch, "git", "worktree", "list")
    assert manager.get_registered_worktrees() == set()
    assert "Timeout listing worktrees" in caplog.text


def test_cleanup_removes_orphans_then_expired_then_the_oldest(
    manager, repo, monkeypatch
):
    monkeypatch.setenv("PR_WORKTREE_MAX_AGE_DAYS", "3")
    monkeypatch.setenv("MAX_PR_WORKTREES", "1")
    orphan = manager.worktree_base_dir / "pr-1-orphan"
    orphan.mkdir(parents=True)
    expired = manager.create_worktree(head(repo), 2, auto_cleanup=False)
    older = manager.create_worktree(head(repo), 3, auto_cleanup=False)
    newest = manager.create_worktree(head(repo), 4, auto_cleanup=False)
    age(expired, 10)
    age(older, 1)
    stats = manager.cleanup_worktrees()
    assert stats == {"orphaned": 1, "expired": 1, "excess": 1, "total": 3}
    assert [p.exists() for p in (orphan, expired, older, newest)] == [
        False,
        False,
        False,
        True,
    ]
    assert manager.cleanup_worktrees()["total"] == 0


def test_a_forced_cleanup_keeps_old_ones_within_the_count(manager, repo, monkeypatch):
    monkeypatch.setenv("PR_WORKTREE_MAX_AGE_DAYS", "0")
    old = manager.create_worktree(head(repo), 2, auto_cleanup=False)
    age(old, 30)
    assert manager.cleanup_worktrees(force=True)["total"] == 0
    assert old.exists()


def test_a_prune_that_hangs_does_not_stop_the_cleanup(
    manager, repo, monkeypatch, caplog
):
    orphan = manager.worktree_base_dir / "pr-1-orphan"
    orphan.mkdir(parents=True)
    hang(monkeypatch, "git", "worktree", "prune")
    assert manager.cleanup_worktrees()["orphaned"] == 1
    assert "Timeout pruning worktrees, continuing anyway" in caplog.text


def test_cleanup_without_any_worktree_folder_has_nothing_to_do(manager):
    assert manager.cleanup_worktrees() == {
        "orphaned": 0,
        "expired": 0,
        "excess": 0,
        "total": 0,
    }
    assert manager.cleanup_all_worktrees() == 0


def test_removing_everything_removes_every_worktree(manager, repo, monkeypatch, caplog):
    manager.worktree_base_dir.mkdir(parents=True)
    assert manager.cleanup_all_worktrees() == 0
    for number in (1, 2):
        manager.create_worktree(head(repo), number, auto_cleanup=False)
    hang(monkeypatch, "git", "worktree", "prune")
    assert manager.cleanup_all_worktrees() == 2
    assert list(manager.worktree_base_dir.iterdir()) == []
    assert "Timeout pruning worktrees after cleanup" in caplog.text


@pytest.mark.parametrize(
    ("count", "days", "expected"),
    [("abc", "x", (10, 7)), ("-1", "-2", (10, 7)), ("3", "0", (3, 0))],
)
def test_the_limits_come_from_the_environment_or_the_defaults(
    monkeypatch, count, days, expected
):
    monkeypatch.setenv("MAX_PR_WORKTREES", count)
    monkeypatch.setenv("PR_WORKTREE_MAX_AGE_DAYS", days)
    assert (
        manager_module._get_max_pr_worktrees(),
        manager_module._get_max_age_days(),
    ) == expected
