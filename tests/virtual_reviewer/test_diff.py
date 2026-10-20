"""Tests for the task diff summary the virtual reviewer reads."""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from virtual_reviewer.diff import compute_diff_summary


def _git_init_with_change(repo: Path) -> None:
    """Create a minimal repo with one commit + an unstaged modification."""
    subprocess.run(["git", "init", "-q", "-b", "main"], cwd=repo, check=True)
    subprocess.run(
        ["git", "config", "user.email", "test@example.com"], cwd=repo, check=True
    )
    subprocess.run(["git", "config", "user.name", "test"], cwd=repo, check=True)
    (repo / "src.py").write_text("def foo():\n    return 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-q", "-m", "init"], cwd=repo, check=True)
    # Modify the file so we have a diff vs HEAD.
    (repo / "src.py").write_text(
        "def foo():\n    return 2\n\ndef bar():\n    return 'x'\n",
        encoding="utf-8",
    )


class TestComputeDiffSummary:
    def test_missing_dir_returns_error(self, tmp_path: Path) -> None:
        result = compute_diff_summary(tmp_path / "spec", tmp_path / "ghost")
        assert result.files_changed == []
        assert result.error and "not a directory" in result.error

    def test_non_git_dir_returns_error(self, tmp_path: Path) -> None:
        result = compute_diff_summary(tmp_path / "spec", tmp_path)
        assert result.error and "not a git repo" in result.error

    @pytest.mark.skipif(
        subprocess.run(["git", "--version"], capture_output=True).returncode != 0,
        reason="git not available",
    )
    def test_collects_files_and_stats_from_real_repo(self, tmp_path: Path) -> None:
        _git_init_with_change(tmp_path)
        result = compute_diff_summary(tmp_path / "spec", tmp_path)
        assert result.error is None
        assert "src.py" in result.files_changed
        assert result.insertions > 0
        assert result.diff_excerpt
        assert "def bar" in result.diff_excerpt

    def test_long_diff_is_truncated(self, tmp_path: Path) -> None:
        # Force a huge fake diff via monkeypatching the git wrapper.
        from virtual_reviewer import diff as sr

        # `for_model` is the opt-in that routes an excerpt through rtk; the
        # stub accepts it because it stands in for the one wrapper, whichever
        # way a caller asks for the output.
        def fake_git(args, cwd, *, for_model=False):
            if args == ["rev-parse", "--is-inside-work-tree"]:
                return 0, "true\n", ""
            if args == ["diff", "HEAD", "--name-only"]:
                return 0, "x.py\n", ""
            if args == ["diff", "HEAD", "--numstat"]:
                return 0, "1\t0\tx.py\n", ""
            if args == ["diff", "HEAD"]:
                return 0, "x" * 100_000, ""
            return 1, "", "unexpected"

        # The function patched is module-level; replace it for this test only.
        original = sr._git
        sr._git = fake_git
        try:
            result = compute_diff_summary(tmp_path, tmp_path)
            assert result.truncated is True
            assert "[truncated by diff excerpt cap]" in result.diff_excerpt
            assert len(result.diff_excerpt) < 100_000
        finally:
            sr._git = original
