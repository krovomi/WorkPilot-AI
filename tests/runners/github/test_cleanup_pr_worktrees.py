"""runners/github/cleanup_pr_worktrees.py: the hand-run tool that lists and prunes PR review worktrees.

Driven through ``main()`` against a real repository and the real
``PRWorktreeManager``: what it prints and which worktrees are left on disk.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

TOOL = (
    Path(__file__).resolve().parents[3]
    / "apps"
    / "backend"
    / "runners"
    / "github"
    / "cleanup_pr_worktrees.py"
)
WORKTREES = ".workpilot/github/pr/worktrees"


@pytest.fixture(scope="module")
def tool():
    spec = importlib.util.spec_from_file_location("cleanup_pr_worktrees", TOOL)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", *args],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout


@pytest.fixture
def repo(tmp_path, monkeypatch):
    for var in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    monkeypatch.delenv("MAX_PR_WORKTREES", raising=False)
    monkeypatch.delenv("PR_WORKTREE_MAX_AGE_DAYS", raising=False)
    repo = tmp_path / "project"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "base")
    return repo


def _run(tool, monkeypatch, *argv: str) -> int:
    monkeypatch.setattr(sys, "argv", ["cleanup_pr_worktrees.py", *argv])
    return tool.main()


def _worktree(tool, repo: Path, pr: int) -> Path:
    manager = tool.PRWorktreeManager(project_dir=repo, worktree_dir=WORKTREES)
    return manager.create_worktree(
        _git(repo, "rev-parse", "HEAD").strip(), pr_number=pr
    )


def test_no_action_prints_the_help_and_fails(tool, repo, monkeypatch, capsys):
    assert _run(tool, monkeypatch, "--project-dir", str(repo)) == 1
    assert "--cleanup-all" in capsys.readouterr().out


def test_lists_an_empty_project(tool, repo, monkeypatch, capsys):
    assert _run(tool, monkeypatch, "--project-dir", str(repo), "--list") == 0
    out = capsys.readouterr().out
    assert f"Project directory: {repo}" in out
    assert "No PR review worktrees found." in out


def test_lists_each_worktree_with_its_pr(tool, repo, monkeypatch, capsys):
    path = _worktree(tool, repo, 42)
    assert _run(tool, monkeypatch, "--project-dir", str(repo), "--list") == 0
    out = capsys.readouterr().out
    assert "Found 1 PR review worktrees" in out
    assert path.name in out
    assert "#42" in out


def test_stats_count_orphans_and_the_policy_read_from_the_environment(
    tool, repo, monkeypatch, capsys
):
    _worktree(tool, repo, 1)
    # A folder git does not know about: an orphan.
    (repo / WORKTREES / "pr-2-leftover").mkdir()
    monkeypatch.setenv("MAX_PR_WORKTREES", "1")
    monkeypatch.setenv("PR_WORKTREE_MAX_AGE_DAYS", "3")
    assert _run(tool, monkeypatch, "--project-dir", str(repo), "--stats") == 0
    out = capsys.readouterr().out
    assert "Total worktrees:      2" in out
    assert "Orphaned (not in git): 1" in out
    assert "Excess (>1 limit):   1" in out
    assert "Max age:     3 days" in out


def test_cleanup_with_nothing_to_remove(tool, repo, monkeypatch, capsys):
    path = _worktree(tool, repo, 7)
    assert _run(tool, monkeypatch, "--project-dir", str(repo), "--cleanup") == 0
    assert "No worktrees needed cleanup." in capsys.readouterr().out
    assert path.exists()


def test_cleanup_removes_an_orphan_and_says_so(tool, repo, monkeypatch, capsys):
    kept = _worktree(tool, repo, 7)
    orphan = repo / WORKTREES / "pr-8-leftover"
    orphan.mkdir()
    assert _run(tool, monkeypatch, "--project-dir", str(repo), "--cleanup") == 0
    out = capsys.readouterr().out
    assert "Orphaned removed: 1" in out
    assert "Total removed:    1" in out
    assert not orphan.exists()
    assert kept.exists()


def test_cleanup_all_asks_first(tool, repo, monkeypatch, capsys):
    path = _worktree(tool, repo, 9)
    monkeypatch.setattr("builtins.input", lambda _prompt: "no")
    assert _run(tool, monkeypatch, "--project-dir", str(repo), "--cleanup-all") == 0
    assert "Aborted." in capsys.readouterr().out
    assert path.exists()

    monkeypatch.setattr("builtins.input", lambda _prompt: "YES")
    assert _run(tool, monkeypatch, "--project-dir", str(repo), "--cleanup-all") == 0
    out = capsys.readouterr().out
    assert "Removed 1 worktrees." in out
    assert not path.exists()


def test_finds_the_project_from_a_subfolder(tool, repo, monkeypatch):
    (repo / "deep" / "er").mkdir(parents=True)
    monkeypatch.chdir(repo / "deep" / "er")
    assert tool.find_project_root() == repo


def test_outside_a_repository_reports_the_error(tool, tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert _run(tool, monkeypatch, "--list") == 1
    assert "Error: Not in a git repository" in capsys.readouterr().err


def test_runs_as_the_documented_command(repo):
    """`python cleanup_pr_worktrees.py --list`, as its usage says: no PYTHONPATH."""
    done = subprocess.run(
        [sys.executable, str(TOOL), "--project-dir", str(repo), "--list"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        cwd=repo,
        env={k: v for k, v in os.environ.items() if k != "PYTHONPATH"},
        timeout=60,
    )
    assert done.returncode == 0, done.stderr
    assert "No PR review worktrees found." in done.stdout
