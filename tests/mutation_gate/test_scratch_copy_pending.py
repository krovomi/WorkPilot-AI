"""The scratch copy holds the task's pending changes byte for byte.

The diff once went through a text pipe: reading it turned a CRLF line into
LF, and on Windows writing it turned every LF into CRLF, so `git apply`
refused the patch and the .NET public API gate never built the task's side.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from mutation_gate.sandbox import scratch_copy


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    # The bytes on disk are the bytes in git, whatever the machine's setting.
    _git(root, "config", "core.autocrlf", "false")
    (root / "Api.cs").write_bytes(
        b"public class Api\r\n{\r\n    void Run() {}\r\n}\r\n"
    )
    (root / "notes.txt").write_bytes(b"one\ntwo\n")
    (root / "last.txt").write_bytes(b"no newline at the end")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", "base")
    return root


def test_crlf_lf_and_unterminated_changes_reach_the_copy_unchanged(repo: Path):
    changed = {
        "Api.cs": b"public class Api\r\n{\r\n    // Run is gone\r\n}\r\n",
        "notes.txt": b"one\ntwo\nthree\n",
        "last.txt": b"still no newline",
    }
    for name, data in changed.items():
        (repo / name).write_bytes(data)

    with scratch_copy(repo) as copy:
        for name, data in changed.items():
            assert (copy / name).read_bytes() == data, name

    # The task's own tree is untouched, and the copy is gone.
    for name, data in changed.items():
        assert (repo / name).read_bytes() == data
    assert _git(repo, "worktree", "list").count("\n") == 0


def test_a_tree_without_pending_changes_is_the_commit(repo: Path):
    with scratch_copy(repo) as copy:
        assert (copy / "Api.cs").read_bytes() == (repo / "Api.cs").read_bytes()
        assert not (copy / "pending.patch").exists()
