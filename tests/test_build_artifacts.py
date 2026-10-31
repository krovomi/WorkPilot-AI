"""Build and test outputs never reach a task's branch (core.build_artifacts).

Reproduces the report of 31 October: for "Create toto.txt" in a .NET project
without a .gitignore, the review listed 268 files (bin/, obj/, TestResults/).
"""

import subprocess
import sys
from pathlib import Path

import pytest

backend_path = Path(__file__).parent.parent / "apps" / "backend"
sys.path.insert(0, str(backend_path))

from core.build_artifacts import (  # noqa: E402
    BLOCK_BEGIN,
    BLOCK_END,
    detect_patterns,
    ensure_artifact_excludes,
    render_block,
    replace_block,
    strip_committed_artifacts,
)
from core.worktree import WorktreeManager  # noqa: E402


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True
    ).stdout


def _write(root: Path, rel: str, content: str = "x") -> None:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.fixture
def dotnet_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "config", "user.email", "t@example.com")
    _git(repo, "config", "user.name", "Test")
    _write(repo, "src/Rag.Domain/Rag.Domain.csproj", "<Project />")
    _write(repo, "src/Rag.Domain/Service.cs", "class S {}")
    _git(repo, "add", ".")
    _git(repo, "commit", "-q", "-m", "init")
    return repo


def _worktree(repo: Path) -> Path:
    wt = repo.parent / "wt"
    _git(repo, "worktree", "add", "-q", "-b", "task", str(wt))
    return wt


def _build_outputs(wt: Path) -> None:
    _write(wt, "src/Rag.Domain/bin/Debug/net10.0/Rag.Domain.dll")
    _write(wt, "src/Rag.Domain/obj/project.assets.json")
    _write(wt, "tests/Rag.Tests/TestResults/abc/coverage.cobertura.xml")


class TestDetectPatterns:
    def test_dotnet_markers_add_bin_and_obj(self):
        patterns = detect_patterns(["src/App/App.csproj"])
        assert "[Bb]in/" in patterns
        assert "[Oo]bj/" in patterns

    def test_bin_is_not_excluded_without_dotnet(self):
        """bin/ holds scripts in a Node or shell project."""
        patterns = detect_patterns(["package.json", "bin/cli.js"])
        assert "[Bb]in/" not in patterns
        assert "node_modules/" in patterns
        assert "dist/" in patterns

    def test_common_patterns_always_apply(self):
        patterns = detect_patterns([])
        for expected in ("node_modules/", "__pycache__/", "TestResults/"):
            assert expected in patterns


class TestManagedBlock:
    def test_block_is_appended_once_then_replaced(self):
        content = replace_block("*.log", render_block(["a/"]))
        assert content.startswith("*.log\n")
        content = replace_block(content, render_block(["b/"]))
        assert content.count(BLOCK_BEGIN) == 1
        assert content.count(BLOCK_END) == 1
        assert "b/" in content
        assert "a/" not in content
        assert content.startswith("*.log\n")


class TestEnsureExcludes:
    def test_git_add_skips_build_outputs(self, dotnet_repo: Path):
        wt = _worktree(dotnet_repo)
        ensure_artifact_excludes(wt)
        _build_outputs(wt)
        _write(wt, "toto.txt", "hello")

        _git(wt, "add", ".")

        staged = _git(wt, "diff", "--cached", "--name-only").split()
        assert staged == ["toto.txt"]

    def test_exclude_is_written_in_the_shared_git_dir(self, dotnet_repo: Path):
        wt = _worktree(dotnet_repo)
        ensure_artifact_excludes(wt)
        ensure_artifact_excludes(wt)
        exclude = dotnet_repo / ".git" / "info" / "exclude"
        content = exclude.read_text(encoding="utf-8")
        assert content.count(BLOCK_BEGIN) == 1
        assert "[Oo]bj/" in content

    def test_pattern_matching_a_versioned_file_is_left_out(self, dotnet_repo: Path):
        """A project that commits a bin/ folder keeps being able to add to it."""
        _write(dotnet_repo, "scripts/bin/tool.sh", "echo")
        _git(dotnet_repo, "add", ".")
        _git(dotnet_repo, "commit", "-q", "-m", "scripts")
        wt = _worktree(dotnet_repo)

        patterns = ensure_artifact_excludes(wt)

        assert "[Bb]in/" not in patterns
        # The configuration folders stay covered.
        assert "**/[Bb]in/[Dd]ebug/" in patterns
        assert "[Oo]bj/" in patterns

    def test_outputs_committed_on_the_branch_do_not_count_as_versioned(
        self, dotnet_repo: Path
    ):
        wt = _worktree(dotnet_repo)
        _build_outputs(wt)
        _git(wt, "add", ".")
        _git(wt, "commit", "-q", "-m", "agent")

        patterns = ensure_artifact_excludes(wt, "main")

        assert "[Oo]bj/" in patterns
        assert "TestResults/" in patterns

    def test_new_project_created_in_the_task_is_detected(self, tmp_path: Path):
        repo = tmp_path / "repo"
        repo.mkdir()
        _git(repo, "init", "-q", "-b", "main")
        _git(repo, "config", "user.email", "t@example.com")
        _git(repo, "config", "user.name", "Test")
        _write(repo, "README.md", "doc")
        _git(repo, "add", ".")
        _git(repo, "commit", "-q", "-m", "init")
        wt = _worktree(repo)
        _write(wt, "Api/Api.csproj", "<Project />")

        assert "[Oo]bj/" in ensure_artifact_excludes(wt)


class TestStripCommittedArtifacts:
    def test_removes_outputs_the_branch_added(self, dotnet_repo: Path):
        wt = _worktree(dotnet_repo)
        _build_outputs(wt)
        _write(wt, "toto.txt", "hello")
        _git(wt, "add", ".")
        _git(wt, "commit", "-q", "-m", "agent")

        removed = strip_committed_artifacts(wt, "main")

        assert len(removed) == 3
        changed = _git(wt, "diff", "--name-only", "main...HEAD").split()
        assert changed == ["toto.txt"]
        # The outputs stay on disk for the build.
        assert (wt / "src/Rag.Domain/obj/project.assets.json").exists()
        assert _git(wt, "status", "--porcelain").strip() == ""

    def test_respects_the_project_gitignore(self, dotnet_repo: Path):
        _write(dotnet_repo, ".gitignore", "*.local\n")
        _git(dotnet_repo, "add", ".")
        _git(dotnet_repo, "commit", "-q", "-m", "ignore")
        wt = _worktree(dotnet_repo)
        _write(wt, "settings.local", "secret")
        _git(wt, "add", "-f", "settings.local")
        _git(wt, "commit", "-q", "-m", "agent")

        assert strip_committed_artifacts(wt, "main") == ["settings.local"]

    def test_never_touches_files_of_the_base_branch(self, dotnet_repo: Path):
        _write(dotnet_repo, "src/Rag.Domain/obj/keep.json", "{}")
        _git(dotnet_repo, "add", ".")
        _git(dotnet_repo, "commit", "-q", "-m", "versioned obj")
        wt = _worktree(dotnet_repo)
        _write(wt, "toto.txt")
        _git(wt, "add", ".")
        _git(wt, "commit", "-q", "-m", "agent")

        assert strip_committed_artifacts(wt, "main") == []
        assert "src/Rag.Domain/obj/keep.json" in _git(wt, "ls-files").split()

    def test_nothing_to_strip_makes_no_commit(self, dotnet_repo: Path):
        wt = _worktree(dotnet_repo)
        _write(wt, "toto.txt")
        _git(wt, "add", ".")
        _git(wt, "commit", "-q", "-m", "agent")
        head = _git(wt, "rev-parse", "HEAD")

        assert strip_committed_artifacts(wt, "main") == []
        assert _git(wt, "rev-parse", "HEAD") == head


class TestWorktreeManagerIntegration:
    def test_commit_in_worktree_leaves_outputs_out(self, dotnet_repo: Path):
        manager = WorktreeManager(dotnet_repo)
        info = manager.create_worktree("002-create-toto")
        _build_outputs(info.path)
        _write(info.path, "toto.txt", "hello")

        assert manager.commit_in_worktree("002-create-toto", "agent work")

        changed = [
            path for _status, path in manager.get_changed_files("002-create-toto")
        ]
        assert changed == ["toto.txt"]

    def test_strip_build_artifacts_cleans_the_review_diff(self, dotnet_repo: Path):
        manager = WorktreeManager(dotnet_repo)
        info = manager.create_worktree("002-create-toto")
        _build_outputs(info.path)
        _write(info.path, "toto.txt", "hello")
        _git(info.path, "add", ".")
        _git(info.path, "commit", "-q", "-m", "agent")

        assert len(manager.strip_build_artifacts("002-create-toto")) == 3

        changed = [
            path for _status, path in manager.get_changed_files("002-create-toto")
        ]
        assert changed == ["toto.txt"]
