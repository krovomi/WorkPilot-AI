"""A file the agent created but never committed is still a change of the task.

Report of 1 November: a task ended with a new file, and the review's
"Fichiers modifiés" showed "0 files changed" after "Vérifier les conflits";
the merge would have left the file behind. The build now commits what the
agent left pending, and the merge preview counts the worktree, not only HEAD.
"""

import subprocess
import sys
from pathlib import Path

import pytest

backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

from cli.workspace_commands import _get_changed_files_from_git  # noqa: E402
from core.worktree import WorktreeManager  # noqa: E402

SPEC = "001-create-toto"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout


def _write(root: Path, rel: str, content: str = "x") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "Test")
    _write(repo, "README.md", "hello\n")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


def _changed(manager: WorktreeManager) -> list[str]:
    return sorted(path for _status, path in manager.get_changed_files(SPEC))


class TestCommitPendingChanges:
    def test_commits_a_file_the_agent_left_untracked(self, repo: Path):
        manager = WorktreeManager(repo)
        info = manager.create_worktree(SPEC)
        _write(info.path, "toto.txt", "toto\n")
        assert _changed(manager) == []

        assert manager.commit_pending_changes(SPEC) == ["toto.txt"]

        assert _changed(manager) == ["toto.txt"]
        assert _git(info.path, "status", "--porcelain") == ""

    def test_keeps_workpilot_and_build_outputs_out(self, repo: Path):
        manager = WorktreeManager(repo)
        info = manager.create_worktree(SPEC)
        _write(info.path, "toto.txt", "toto\n")
        _write(info.path, ".workpilot-discard-list", "")
        _write(info.path, "bin/Debug/app.dll", "binary")
        manager.ensure_build_artifact_excludes(SPEC)

        manager.commit_pending_changes(SPEC)

        assert _changed(manager) == ["toto.txt"]

    def test_does_nothing_on_a_clean_worktree(self, repo: Path):
        manager = WorktreeManager(repo)
        info = manager.create_worktree(SPEC)
        head = _git(info.path, "rev-parse", "HEAD")

        assert manager.commit_pending_changes(SPEC) == []

        assert _git(info.path, "rev-parse", "HEAD") == head


class TestMergePreviewChangedFiles:
    def test_counts_committed_uncommitted_and_untracked_files(self, repo: Path):
        manager = WorktreeManager(repo)
        info = manager.create_worktree(SPEC)
        _write(info.path, "committed.txt", "c\n")
        _git(info.path, "add", "committed.txt")
        _git(info.path, "commit", "-q", "-m", "agent")
        _write(info.path, "README.md", "hello\nworld\n")
        _write(info.path, "toto.txt", "toto\n")
        _write(info.path, ".workpilot-discard-list", "")

        files = _get_changed_files_from_git(info.path, "main")

        assert sorted(files) == ["README.md", "committed.txt", "toto.txt"]
