"""`WorktreeManager` on real repositories: base branch, life cycle, merge, cleanup.

Every test drives git in ``tmp_path``; nothing stands in for git. The
push / pull request half is in ``test_worktree_forge.py``.
"""

from __future__ import annotations

import os
import stat
import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import core.worktree as worktree_module
import pytest
from core.worktree import WorktreeError, WorktreeManager

SPEC = "002-checkout"
BRANCH = f"workpilot/{SPEC}"


def git(cwd: Path, *args: str, check: bool = True, env: dict | None = None):
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=check,
        env={**os.environ, **(env or {})},
    )


def commit_file(cwd: Path, name: str, content: str, message: str, env=None) -> None:
    path = cwd / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    git(cwd, "add", "-f", "--", name)
    git(cwd, "commit", "-m", message, env=env)


def hook(repo: Path, name: str, body: str) -> None:
    hooks = repo / ".git" / "hooks"
    hooks.mkdir(parents=True, exist_ok=True)
    path = hooks / name
    path.write_text("#!/bin/sh\n" + body, encoding="utf-8", newline="\n")
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


@pytest.fixture
def repo(temp_git_repo, tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(tmp_path / "no-global-gitconfig"))
    monkeypatch.setenv("GIT_TERMINAL_PROMPT", "0")
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    # `git worktree add` retries back off with `time.sleep`; not here.
    monkeypatch.setattr(worktree_module, "time", SimpleNamespace(sleep=lambda _s: None))
    return temp_git_repo


@pytest.fixture
def manager(repo):
    return WorktreeManager(repo, base_branch="main", use_local_branch=True)


@pytest.fixture
def task(manager):
    """A task worktree with one commit of its own."""
    info = manager.create_worktree(SPEC)
    commit_file(info.path, "pay.py", "def pay():\n    return True\n", "pay")
    return info


# ── The base branch ─────────────────────────────────────────────────────


class TestBaseBranch:
    def test_default_branch_from_the_environment(self, repo, monkeypatch):
        git(repo, "branch", "release")
        monkeypatch.setenv("DEFAULT_BRANCH", "release")

        assert WorktreeManager(repo).base_branch == "release"

    def test_an_unknown_default_branch_is_detected_instead(
        self, repo, monkeypatch, capsys
    ):
        monkeypatch.setenv("DEFAULT_BRANCH", "nope")

        assert WorktreeManager(repo).base_branch == "main"
        assert "DEFAULT_BRANCH 'nope' not found" in capsys.readouterr().out

    def test_the_remote_default_branch_wins(self, repo):
        git(repo, "branch", "trunk")
        git(repo, "update-ref", "refs/remotes/origin/trunk", "trunk")
        git(
            repo,
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/trunk",
        )

        assert WorktreeManager(repo).base_branch == "trunk"

    def test_develop_is_a_usual_default(self, repo):
        git(repo, "branch", "-m", "main", "develop")

        assert WorktreeManager(repo).base_branch == "develop"

    def test_the_current_branch_is_the_last_resort(self, repo, capsys):
        git(repo, "branch", "-m", "main", "feature-x")

        assert WorktreeManager(repo).base_branch == "feature-x"
        assert "Using current branch 'feature-x'" in capsys.readouterr().out

    def test_no_repository_no_current_branch(self, tmp_path):
        plain = tmp_path / "plain"
        plain.mkdir()

        with pytest.raises(WorktreeError, match="Failed to get current branch"):
            WorktreeManager(plain)


# ── Creating and finding worktrees ──────────────────────────────────────


class TestCreateWorktree:
    def test_a_branch_named_workpilot_blocks_the_namespace(self, manager, repo):
        git(repo, "branch", "workpilot")

        with pytest.raises(WorktreeError, match="Branch 'workpilot' exists"):
            manager.create_worktree(SPEC)

    def test_creating_twice_returns_the_same_worktree(self, manager, task, capsys):
        again = manager.create_worktree(SPEC)

        assert again.path == task.path
        assert again.branch == BRANCH
        assert "Using existing worktree" in capsys.readouterr().out
        assert manager.get_or_create_worktree(SPEC).path == task.path

    def test_a_broken_worktree_is_recreated(self, manager, task):
        # Regression: git refuses `worktree remove --force` on a `.git` file it
        # cannot validate, and the task could never get a worktree again.
        (task.path / ".git").write_text("gitdir: /nowhere\n", encoding="utf-8")
        assert manager.get_worktree_info(SPEC) is None

        info = manager.create_worktree(SPEC)

        assert info.branch == BRANCH
        assert (info.path / "pay.py").exists()  # the branch was reused

    def test_a_stale_directory_is_replaced(self, manager, repo):
        stale = manager.get_worktree_path(SPEC)
        stale.mkdir(parents=True)
        (stale / "leftover.txt").write_text("x", encoding="utf-8")

        info = manager.create_worktree(SPEC)

        assert not (info.path / "leftover.txt").exists()
        assert (info.path / "README.md").exists()

    def test_starts_from_the_remote_base_when_fetched(self, repo, tmp_path):
        bare = tmp_path / "origin.git"
        git(tmp_path, "init", "--bare", "-b", "main", str(bare))
        git(repo, "remote", "add", "origin", str(bare))
        git(repo, "push", "origin", "main")
        other = tmp_path / "other"
        git(tmp_path, "clone", str(bare), str(other))
        git(other, "config", "user.email", "o@example.com")
        git(other, "config", "user.name", "O")
        commit_file(other, "remote.txt", "from the remote\n", "remote")
        git(other, "push", "origin", "main")

        info = WorktreeManager(repo, base_branch="main").create_worktree(SPEC)

        assert (info.path / "remote.txt").exists()

    def test_an_unreachable_remote_falls_back_to_the_local_base(
        self, repo, tmp_path, capsys
    ):
        git(repo, "remote", "add", "origin", str(tmp_path / "missing.git"))

        info = WorktreeManager(repo, base_branch="main").create_worktree(SPEC)

        out = capsys.readouterr().out
        assert "Could not fetch main from origin" in out
        assert "using local branch: main" in out
        assert info.branch == BRANCH

    def test_an_impossible_worktree_is_an_error(self, manager):
        manager.worktrees_dir.parent.mkdir(parents=True, exist_ok=True)
        manager.worktrees_dir.write_text("a file, not a folder", encoding="utf-8")

        with pytest.raises(
            WorktreeError, match=f"Failed to create worktree for {SPEC}"
        ):
            manager.create_worktree(SPEC)

    def test_a_transient_add_failure_is_retried_then_returned(self, manager, capsys):
        manager.worktrees_dir.parent.mkdir(parents=True, exist_ok=True)
        manager.worktrees_dir.write_text("a file", encoding="utf-8")
        path = manager.worktrees_dir / SPEC

        result = manager._run_worktree_add(
            ["worktree", "add", "-b", BRANCH, str(path), "main"],
            worktree_path=path,
            created_branch=BRANCH,
            max_attempts=2,
        )

        assert result.returncode != 0
        assert "attempt 1/2" in capsys.readouterr().out

    def test_a_legacy_worktree_is_found(self, manager, repo):
        legacy = repo / ".worktrees" / SPEC
        git(repo, "worktree", "add", "-b", BRANCH, str(legacy), "main")

        assert manager.get_worktree_path(SPEC) == legacy
        assert [w.spec_name for w in manager.list_all_worktrees()] == [SPEC]

    def test_info_and_stats(self, manager, task):
        info = manager.get_worktree_info(SPEC)

        assert info.commit_count == 1
        assert info.additions == 2
        assert info.deletions == 0
        assert info.days_since_last_commit == 0
        assert manager.get_changed_files(SPEC) == [("A", "pay.py")]
        assert manager.get_change_summary(SPEC) == {
            "new_files": 1,
            "modified_files": 0,
            "deleted_files": 0,
        }

    def test_a_binary_file_counts_no_lines(self, manager, task):
        (task.path / "logo.bin").write_bytes(b"\x00\x01\x02")
        git(task.path, "add", "logo.bin")
        git(task.path, "commit", "-m", "logo")

        assert manager.get_worktree_info(SPEC).additions == 2

    def test_detached_worktree_reports_its_task_branch(self, manager, task):
        git(task.path, "checkout", "--detach")

        assert manager.get_worktree_info(SPEC).branch == BRANCH

    def test_missing_worktree(self, manager):
        assert manager.get_worktree_info(SPEC) is None
        assert manager.get_changed_files(SPEC) == []
        assert manager._get_worktree_stats(SPEC)["commit_count"] == 0
        assert manager._has_uncommitted_changes(SPEC) == (False, [])
        assert manager._count_commits_ahead(SPEC, "main") is None
        assert manager.commit_in_worktree(SPEC, "m") is False
        assert manager.ensure_build_artifact_excludes(SPEC) == []
        assert manager._strip_workpilot_artifacts(SPEC) == []


# ── Commits in the task worktree ────────────────────────────────────────


class TestCommits:
    def test_pending_changes_are_committed_without_workpilot_files(self, manager, task):
        (task.path / "left.py").write_text("x = 1\n", encoding="utf-8")
        (task.path / ".workpilot-status").write_text("done\n", encoding="utf-8")

        changed = manager.commit_pending_changes(SPEC)

        assert set(changed) == {"left.py", ".workpilot-status"}
        tracked = git(task.path, "ls-files").stdout.split()
        assert "left.py" in tracked
        assert ".workpilot-status" not in tracked
        assert manager.commit_pending_changes(SPEC) == [".workpilot-status"]

    def test_settle_branch_commits_and_strips(self, manager, task):
        (task.path / "left.py").write_text("x = 1\n", encoding="utf-8")

        manager.settle_branch(SPEC)

        assert manager._has_uncommitted_changes(SPEC) == (False, [])

    def test_a_refused_commit_is_reported(self, manager, task, repo, capsys):
        hook(repo, "pre-commit", "echo refused >&2\nexit 1\n")
        (task.path / "left.py").write_text("x = 1\n", encoding="utf-8")

        assert manager.commit_in_worktree(SPEC, "left") is False
        assert "Commit failed: refused" in capsys.readouterr().out

    def test_committed_workpilot_files_leave_the_branch(self, manager, task):
        commit_file(task.path, ".workpilot/specs/x/spec.md", "# x\n", "spec")

        assert manager._strip_workpilot_artifacts(SPEC) == [
            ".workpilot/specs/x/spec.md"
        ]
        assert git(task.path, "ls-files", ".workpilot").stdout == ""
        assert (task.path / ".workpilot" / "specs" / "x" / "spec.md").exists()

    def test_a_refused_strip_commit_keeps_nothing_stripped(
        self, manager, task, repo, caplog
    ):
        commit_file(task.path, ".workpilot-status", "done\n", "status")
        hook(repo, "pre-commit", "exit 1\n")

        assert manager._strip_workpilot_artifacts(SPEC) == []
        assert "Commit of artifact removal failed" in caplog.text

    def test_a_locked_index_stops_the_strip(self, manager, task, caplog):
        commit_file(task.path, ".workpilot-status", "done\n", "status")
        gitdir = git(task.path, "rev-parse", "--git-dir").stdout.strip()
        (task.path / gitdir / "index.lock").write_text("", encoding="utf-8")

        assert manager._strip_workpilot_artifacts(SPEC) == []
        assert "git rm --cached failed" in caplog.text

    def test_commits_ahead(self, manager, task, repo):
        assert manager._count_commits_ahead(SPEC, "main") == 1
        assert manager._count_commits_ahead(SPEC, "origin/main") is None
        git(repo, "branch", "-m", "main", "trunk")
        git(repo, "update-ref", "refs/remotes/origin/main", "trunk")
        assert manager._count_commits_ahead(SPEC, "main") == 1

    def test_uncommitted_changes_anywhere(self, manager, task, repo):
        assert manager.has_uncommitted_changes(SPEC) is False
        (task.path / "pay.py").write_text("changed\n", encoding="utf-8")
        assert manager.has_uncommitted_changes(SPEC) is True
        assert manager.has_uncommitted_changes() is True  # the task dir is untracked


# ── Removing worktrees ──────────────────────────────────────────────────


class TestRemoveWorktree:
    def test_uncommitted_files_block_the_removal(self, manager, task):
        for n in range(12):
            (task.path / f"wip{n:02}.txt").write_text("x", encoding="utf-8")

        with pytest.raises(RuntimeError) as refused:
            manager.remove_worktree(SPEC)

        message = str(refused.value)
        assert "has 12 uncommitted file(s)" in message
        assert "... and 2 more" in message
        assert task.path.exists()

    def test_removal_with_its_branch(self, manager, task, capsys):
        manager.remove_worktree(SPEC, delete_branch=True)

        assert not task.path.exists()
        assert not manager._branch_exists(BRANCH)
        assert f"Deleted branch: {BRANCH}" in capsys.readouterr().out

    def test_a_locked_worktree_is_not_deleted_behind_git(self, manager, task, repo):
        git(repo, "worktree", "lock", str(task.path))

        with pytest.raises(RuntimeError, match=f"Failed to remove worktree '{SPEC}'"):
            manager.remove_worktree(SPEC)
        assert task.path.exists()

    def test_cleanup_all(self, manager, task):
        manager.cleanup_all()

        assert manager.list_all_worktrees() == []
        assert not manager._branch_exists(BRANCH)

    def test_setup_creates_the_worktrees_dir(self, manager):
        assert not manager.worktrees_dir.exists()
        manager.setup()
        assert manager.worktrees_dir.is_dir()


# ── Merging back ────────────────────────────────────────────────────────


class TestMergeWorktree:
    def test_merges_into_the_base_branch(self, manager, task, repo):
        assert manager.merge_worktree(SPEC) is True

        assert (repo / "pay.py").exists()
        subject = git(repo, "log", "-1", "--format=%s").stdout.strip()
        assert subject == f"workpilot: Merge {BRANCH}"

    def test_switches_to_the_base_branch_first(self, manager, task, repo):
        git(repo, "checkout", "-b", "elsewhere")

        assert manager.merge_worktree(SPEC) is True
        assert manager._get_current_branch() == "main"

    def test_a_failing_checkout_hook_does_not_stop_the_merge(self, manager, task, repo):
        git(repo, "checkout", "-b", "elsewhere")
        hook(repo, "post-checkout", "exit 1\n")

        assert manager.merge_worktree(SPEC) is True
        assert (repo / "pay.py").exists()

    def test_a_base_branch_that_cannot_be_checked_out(self, task, repo, capsys):
        manager = WorktreeManager(repo, base_branch="gone", use_local_branch=True)

        assert manager.merge_worktree(SPEC) is False
        assert "Could not checkout base branch" in capsys.readouterr().out

    def test_no_commit_stages_without_workpilot_or_ignored_files(
        self, manager, task, repo
    ):
        (repo / ".gitignore").write_text("secret.env\n", encoding="utf-8")
        git(repo, "add", ".gitignore")
        git(repo, "commit", "-m", "ignore")
        commit_file(task.path, "secret.env", "KEY=placeholder\n", "env")
        commit_file(task.path, ".workpilot/specs/x/plan.json", "{}\n", "plan")
        commit_file(task.path, "app/workpilot/specs/y.md", "y\n", "nested")

        assert manager.merge_worktree(SPEC, no_commit=True) is True

        # Regression: check-ignore skipped staged files, so the ignored file
        # stayed staged in the project.
        staged = git(repo, "diff", "--cached", "--name-only").stdout.split()
        assert staged == ["pay.py"]

    def test_no_commit_with_nothing_new(self, manager, repo, capsys):
        manager.create_worktree(SPEC)

        assert manager.merge_worktree(SPEC, no_commit=True) is True
        assert git(repo, "diff", "--cached", "--name-only").stdout == ""

    def test_a_conflict_is_aborted(self, manager, task, repo, capsys):
        commit_file(repo, "pay.py", "def pay():\n    return False\n", "main pay")

        assert manager.merge_worktree(SPEC) is False

        assert "Merge conflict! Aborting merge..." in capsys.readouterr().out
        assert not (repo / ".git" / "MERGE_HEAD").exists()

    def test_another_merge_failure_is_aborted(self, manager, task, repo, capsys):
        (repo / "pay.py").write_text("untracked in the way\n", encoding="utf-8")

        assert manager.merge_worktree(SPEC) is False
        assert "Merge failed:" in capsys.readouterr().out

    def test_merge_then_remove(self, manager, task):
        assert manager.merge_worktree(SPEC, delete_after=True) is True

        assert not task.path.exists()
        assert not manager._branch_exists(BRANCH)

    def test_a_dirty_worktree_survives_the_merge(self, manager, task, capsys):
        (task.path / "wip.txt").write_text("x", encoding="utf-8")

        assert manager.merge_worktree(SPEC, delete_after=True) is True

        assert task.path.exists()
        assert "WARNING: Worktree cleanup failed" in capsys.readouterr().out

    def test_no_worktree_no_merge(self, manager, capsys):
        assert manager.merge_worktree(SPEC) is False
        assert f"No worktree found for spec: {SPEC}" in capsys.readouterr().out


# ── Age, warnings and summaries ─────────────────────────────────────────


def old_task(manager, spec: str, days: int) -> None:
    info = manager.create_worktree(spec)
    date = (datetime.now(UTC) - timedelta(days=days, hours=1)).strftime(
        "%Y-%m-%dT%H:%M:%S+0000"
    )
    commit_file(
        info.path,
        f"{spec}.txt",
        spec,
        spec,
        env={"GIT_COMMITTER_DATE": date, "GIT_AUTHOR_DATE": date},
    )


class TestAge:
    def test_old_worktrees(self, manager):
        old_task(manager, "010-fresh", 0)
        old_task(manager, "011-month", 45)
        old_task(manager, "012-ancient", 120)

        assert sorted(manager.get_old_worktrees(days_threshold=30)) == [
            "011-month",
            "012-ancient",
        ]
        infos = manager.get_old_worktrees(days_threshold=100, include_stats=True)
        assert [i.spec_name for i in infos] == ["012-ancient"]

    def test_cleanup_old_worktrees(self, manager, capsys):
        old_task(manager, "010-fresh", 0)
        old_task(manager, "011-month", 45)

        assert manager.cleanup_old_worktrees(dry_run=True) == ([], [])
        assert "[DRY RUN] Would remove 1 old worktrees" in capsys.readouterr().out

        removed, failed = manager.cleanup_old_worktrees()

        assert (removed, failed) == (["011-month"], [])
        assert [w.spec_name for w in manager.list_all_worktrees()] == ["010-fresh"]
        assert manager.cleanup_old_worktrees() == ([], [])

    def test_a_dirty_old_worktree_is_reported_as_failed(self, manager, capsys):
        old_task(manager, "011-month", 45)
        (manager.get_worktree_path("011-month") / "wip.txt").write_text("x", "utf-8")

        assert manager.cleanup_old_worktrees() == ([], ["011-month"])
        assert "Failed to remove 1 worktree(s)." in capsys.readouterr().out

    def test_count_warnings(self, manager):
        old_task(manager, "010-fresh", 0)
        old_task(manager, "011-month", 45)

        assert manager.get_worktree_count_warning() is None
        assert manager.get_worktree_count_warning(warning_threshold=2) == (
            "WARNING: 2 worktrees detected. 1 are 30+ days old and may be safe "
            "to clean up."
        )
        assert manager.get_worktree_count_warning(critical_threshold=2).startswith(
            "CRITICAL: 2 worktrees detected!"
        )

    def test_summary(self, manager, capsys):
        manager.print_worktree_summary()
        assert "No worktrees found." in capsys.readouterr().out

        old_task(manager, "010-fresh", 0)
        old_task(manager, "011-week", 10)
        old_task(manager, "012-month", 45)
        old_task(manager, "013-ancient", 120)
        manager.worktrees_dir.joinpath("014-broken").mkdir()
        (manager.worktrees_dir / "014-broken" / ".git").write_text(
            "gitdir: /nowhere\n", encoding="utf-8"
        )

        manager.print_worktree_summary()

        out = capsys.readouterr().out
        assert "Worktree Summary (4 total)" in out
        for group in ("Recent", "Week Old", "Month Old", "Very Old"):
            assert f"{group} (" in out
        assert "2 worktree(s) are 30+ days old" in out


class TestTestCommands:
    def test_commands_follow_the_project_files(self, manager, task):
        for name in ("package.json", "requirements.txt", "Cargo.toml", "go.mod"):
            (task.path / name).write_text("", encoding="utf-8")

        assert manager.get_test_commands(SPEC) == [
            "npm install && npm run dev",
            "npm test",
            "pip install -r requirements.txt",
            "cargo run",
            "cargo test",
            "go run .",
            "go test ./...",
        ]

    def test_no_known_project(self, manager, task):
        assert manager.get_test_commands(SPEC) == [
            "# Check the project's README for run instructions"
        ]
