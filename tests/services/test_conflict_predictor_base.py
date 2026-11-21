"""Branches are compared with the branch they start from, since they left it.

A repository whose base branch is `master` was compared with `main`, which
it does not have: nothing was ever found. And a two-dot diff counted what
the base changed after a branch left it as a change of that branch, so two
branches that never touched a file "conflicted" on it.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from services.conflict_predictor_service import (
    ConflictPredictorService,
    FileModification,
)


def _git(cwd: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True)


def _commit(repo: Path, files: dict[str, str], message: str) -> None:
    for rel, text in files.items():
        (repo / rel).write_text(text, encoding="utf-8")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", message)


@pytest.fixture
def repo(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    root = tmp_path / "shop"
    root.mkdir()
    _git(root, "init", "-q", "-b", "master")
    _git(root, "config", "user.email", "dev@example.test")
    _git(root, "config", "user.name", "Dev")
    _commit(root, {"README.md": "shop\n", "shared.py": "x = 1\n"}, "init")
    for name, text in (("feat-x", "shop\nx\n"), ("feat-y", "shop\ny\n")):
        _git(root, "checkout", "-q", "-b", name, "master")
        _commit(root, {"README.md": text}, name)
        _git(root, "checkout", "-q", "master")
    # The base moves on after both branches left it.
    _commit(root, {"shared.py": "x = 2\n"}, "base moves")
    # A remote whose HEAD alias shows up in `git branch -a`.
    remote = tmp_path / "remote.git"
    _git(tmp_path, "init", "-q", "--bare", str(remote))
    _git(root, "remote", "add", "origin", str(remote))
    _git(root, "push", "-q", "origin", "master")
    _git(root, "remote", "set-head", "origin", "master")
    return root


def test_branches_are_compared_with_their_own_base(repo: Path) -> None:
    result = ConflictPredictorService().analyze_project_conflicts(str(repo))

    assert result.active_worktrees == ["feat-x", "feat-y"]
    files = {(m.branch_name, m.file_path, m.lines_added) for m in result.modified_files}
    assert files == {("feat-x", "README.md", 1), ("feat-y", "README.md", 1)}
    assert [
        (c.file_path, c.worktree1, c.worktree2) for c in result.conflicts_detected
    ] == [("README.md", "feat-x", "feat-y")]


def test_the_base_named_by_default_branch_is_used(
    repo: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _git(repo, "branch", "trunk", "master")
    monkeypatch.setenv("DEFAULT_BRANCH", "trunk")

    result = ConflictPredictorService().analyze_project_conflicts(str(repo))

    assert "trunk" not in result.active_worktrees
    assert {m.file_path for m in result.modified_files} == {"README.md"}


# --- what git answers, line by line -------------------------------------------


def _answers(monkeypatch: pytest.MonkeyPatch, *outputs: tuple[int, str]) -> None:
    import services.conflict_predictor_service as module

    queue = list(outputs)

    def run(*_args, **_kwargs):
        code, out = queue.pop(0)
        return subprocess.CompletedProcess([], code, out, "")

    monkeypatch.setattr(module.subprocess, "run", run)


def test_git_that_refuses_lists_no_branch(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ConflictPredictorService()
    _answers(monkeypatch, (128, ""), (128, ""))

    assert service._get_active_worktrees("/p") == []


def test_blank_lines_are_skipped_everywhere(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ConflictPredictorService()
    _answers(
        monkeypatch,
        (0, "/repo abc [master]\n\n/wt/feat-a def [feat-a]\n"),
        (0, "* master\n  feat-a\n"),
    )
    assert service._get_active_worktrees("/p") == ["feat-a"]

    _answers(monkeypatch, (0, "M\tapp.py\n\nweird\n"), (0, "noise\n \n3\t1\tapp.py\n"))
    [mod] = service._get_worktree_modifications("/p", "feat-a")
    assert (mod.file_path, mod.lines_added, mod.lines_removed) == ("app.py", 3, 1)

    _answers(monkeypatch, (0, "only-one-column\n"))
    assert service._get_line_changes("/p", "feat-a", "x") == (0, 0)


def test_a_diff_git_refuses_gives_nothing(monkeypatch: pytest.MonkeyPatch) -> None:
    service = ConflictPredictorService()

    _answers(monkeypatch, (128, ""))
    assert service._get_worktree_modifications("/p", "gone") == []
    _answers(monkeypatch, (128, ""))
    assert service._get_line_changes("/p", "gone", "x") == (0, 0)


def _mod(path: str, branch: str, added: int = 1) -> FileModification:
    return FileModification(path, "modified", added, 0, branch, branch)


def test_a_file_already_in_conflict_is_not_listed_again_as_extensive() -> None:
    service = ConflictPredictorService()
    mods = [
        _mod("app.py", "a", 80),
        _mod("app.py", "b", 80),
        *[_mod(f"big{i}.py", "a", 60) for i in range(4)],
        _mod("big0.py", "b", 60),
    ]
    conflicts = service._detect_conflicts(mods)

    areas = service._identify_high_risk_areas(conflicts, mods)

    assert areas[0] == "app.py (1 conflicts)"
    assert areas[1].startswith("big0.py (")
    extensive = [a for a in areas if a.endswith("(extensive changes)")]
    assert extensive == [
        "big1.py (extensive changes)",
        "big2.py (extensive changes)",
        "big3.py (extensive changes)",
    ]


def test_two_conflicts_on_one_area_are_counted_together() -> None:
    service = ConflictPredictorService()
    mods = [_mod("app.py", "a"), _mod("app.py", "b"), _mod("app.py", "c")]

    areas = service._identify_high_risk_areas(service._detect_conflicts(mods), mods)

    assert areas == ["app.py (3 conflicts)"]


def test_recommendations_for_a_deletion_alone() -> None:
    service = ConflictPredictorService()
    deleted = FileModification("util.py", "deleted", 0, 3, "a", "a")
    conflicts = service._detect_conflicts([deleted, _mod("util.py", "b")])

    recommendations = service._generate_recommendations(conflicts, [])

    assert recommendations[0] == "High priority: 1 high-risk conflicts need attention"
    assert not any("dependency updates" in r for r in recommendations)
    assert not any("feature flags" in r for r in recommendations)
