"""The git facts a verification reads, on real repositories.

`fingerprint` decides whether `verify-replay` runs at all: two equal values
mean "nothing a replay could catch changed". It used to hash only HEAD, the
diff against HEAD and the *names* of untracked files, which made it blind in
two places — outside git (one constant hash for every tree) and inside a file
the task created and QA then fixed without committing it.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from verify.git import (
    base_commit,
    changed_files,
    fingerprint,
    head_sha,
    main_checkout,
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "verify@example.invalid")
    _git(root, "config", "user.name", "Verify Tests")
    _git(root, "config", "commit.gpgsign", "false")
    return root


def _commit(repo: Path, name: str, text: str, message: str = "c") -> None:
    (repo / name).write_text(text, encoding="utf-8")
    _git(repo, "add", name)
    _git(repo, "commit", "-q", "-m", message)


def test_outside_git_there_is_no_fingerprint(tmp_path):
    (tmp_path / "app.py").write_text("x = 1\n", encoding="utf-8")
    assert fingerprint(tmp_path) == ""
    assert head_sha(tmp_path) == ""


def test_a_fix_inside_an_untracked_file_changes_the_fingerprint(repo):
    _commit(repo, "app.py", "x = 1\n")
    (repo / "orders.py").write_text("def total():\n    return 1\n", encoding="utf-8")
    before = fingerprint(repo)
    assert before == fingerprint(repo)

    (repo / "orders.py").write_text("def total():\n    return 2\n", encoding="utf-8")

    assert fingerprint(repo) != before


def test_the_verification_folder_is_not_part_of_the_code(repo):
    _commit(repo, "app.py", "x = 1\n")
    before = fingerprint(repo)
    (repo / ".workpilot" / "verify").mkdir(parents=True)
    (repo / ".workpilot" / "verify" / "verify.json").write_text("{}", encoding="utf-8")
    assert fingerprint(repo) == before


def test_tracked_edits_and_commits_change_the_fingerprint(repo):
    _commit(repo, "app.py", "x = 1\n")
    first = fingerprint(repo)
    (repo / "app.py").write_text("x = 2\n", encoding="utf-8")
    edited = fingerprint(repo)
    _git(repo, "commit", "-qam", "x = 2")
    committed = fingerprint(repo)
    assert len({first, edited, committed}) == 3


def test_a_repository_without_a_commit_still_sees_staged_code(repo):
    (repo / "app.py").write_text("x = 1\n", encoding="utf-8")
    _git(repo, "add", "app.py")
    before = fingerprint(repo)
    assert before
    (repo / "app.py").write_text("x = 2\n", encoding="utf-8")
    _git(repo, "add", "app.py")
    assert fingerprint(repo) != before


def test_changed_files_are_the_branch_diff_plus_the_tree(repo):
    _commit(repo, "base.py", "base\n")
    _git(repo, "checkout", "-q", "-b", "task")
    _commit(repo, "feature.py", "f\n")
    (repo / "base.py").write_text("edited\n", encoding="utf-8")
    (repo / "new.py").write_text("n\n", encoding="utf-8")

    assert base_commit(repo) == _git(repo, "rev-parse", "main")
    assert changed_files(repo) == ["feature.py", "base.py", "new.py"]


def test_no_base_branch_means_no_base_commit(repo):
    _commit(repo, "a.py", "a\n")
    _git(repo, "branch", "-m", "main", "solo")
    assert base_commit(repo) == ""
    (repo / "b.py").write_text("b\n", encoding="utf-8")
    # Without a base the tree's own changes are still the answer.
    assert changed_files(repo) == ["b.py"]


def test_a_worktree_points_at_its_main_checkout(repo, tmp_path):
    _commit(repo, "a.py", "a\n")
    tree = tmp_path / "task-tree"
    _git(repo, "worktree", "add", "-q", "--detach", str(tree))
    assert main_checkout(tree).resolve() == repo.resolve()
    assert main_checkout(repo).resolve() == repo.resolve()
    assert main_checkout(tmp_path / "nowhere") is None


def test_a_bare_repository_has_no_main_checkout(tmp_path):
    bare = tmp_path / "bare.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    assert main_checkout(bare) is None


def test_without_git_on_the_path_every_answer_is_empty(repo, monkeypatch):
    _commit(repo, "a.py", "a\n")
    monkeypatch.setenv("PATH", str(repo / "no-bin-here"))
    assert head_sha(repo) == ""
    assert fingerprint(repo) == ""
    assert changed_files(repo) == []


def test_an_untracked_file_that_cannot_be_read_still_counts(repo):
    _commit(repo, "main.py", "print('v1')\n")
    before = fingerprint(repo)
    # A link to nothing: listed by git, unreadable by us.
    try:
        (repo / "data.lnk").symlink_to(repo / "gone.txt")
    except OSError:
        pytest.skip("this machine does not let a test create a symbolic link")
    unreadable = fingerprint(repo)
    assert unreadable and unreadable != before
    assert fingerprint(repo) == unreadable
