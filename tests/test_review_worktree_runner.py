"""The review worktree runner: generated code lands on a card's branch, never in the checkout.

A page that writes code (test studio, Import Design, changelog, pair
programming) asks this runner for the worktree of its Kanban card, writes
there, then asks it to commit. These tests run it as the app does, as a
process, against a real repository.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

RUNNER = (
    Path(__file__).resolve().parent.parent
    / "apps"
    / "backend"
    / "runners"
    / "review_worktree_runner.py"
)
RESULT = "__REVIEW_WORKTREE__:"
ERROR = "__REVIEW_WORKTREE_ERROR__:"


def _git_env(home: Path) -> dict[str, str]:
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith("GIT_") or k == "GIT_CONFIG_NOSYSTEM"
    }
    env.update(
        {
            "HOME": str(home),
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Test",
            "GIT_AUTHOR_EMAIL": "test@example.com",
            "GIT_COMMITTER_NAME": "Test",
            "GIT_COMMITTER_EMAIL": "test@example.com",
            "PYTHONUTF8": "1",
        }
    )
    return env


def _run(repo: Path, *args: str) -> tuple[int, dict | None, str]:
    proc = subprocess.run(
        [sys.executable, str(RUNNER), "--project-dir", str(repo), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=_git_env(repo.parent),
        timeout=120,
    )
    payload = None
    error = ""
    for line in proc.stdout.splitlines():
        if line.startswith(RESULT):
            payload = json.loads(line[len(RESULT) :])
        elif line.startswith(ERROR):
            error = line[len(ERROR) :]
    return proc.returncode, payload, error


def _branch(repo: Path) -> str:
    return subprocess.run(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()


def test_create_makes_the_kanban_worktree_and_branch(temp_git_repo: Path) -> None:
    base = _branch(temp_git_repo)
    code, payload, error = _run(
        temp_git_repo,
        "--action",
        "create",
        "--spec",
        "001-tests",
        "--base-branch",
        base,
    )

    assert code == 0, error
    assert payload is not None
    assert payload["branch"] == "workpilot/001-tests"
    assert payload["base_branch"] == base
    worktree = Path(payload["path"])
    assert (
        worktree == temp_git_repo / ".workpilot" / "worktrees" / "tasks" / "001-tests"
    )
    assert (worktree / "README.md").exists()
    # The person's checkout did not move.
    assert _branch(temp_git_repo) == base


def test_create_twice_reuses_the_same_worktree(temp_git_repo: Path) -> None:
    base = _branch(temp_git_repo)
    _, first, _ = _run(
        temp_git_repo, "--action", "create", "--spec", "002-x", "--base-branch", base
    )
    code, second, error = _run(
        temp_git_repo, "--action", "create", "--spec", "002-x", "--base-branch", base
    )

    assert code == 0, error
    assert first is not None and second is not None
    assert second["path"] == first["path"]


def test_commit_lands_on_the_card_branch_not_the_checkout(temp_git_repo: Path) -> None:
    base = _branch(temp_git_repo)
    _, created, _ = _run(
        temp_git_repo, "--action", "create", "--spec", "003-y", "--base-branch", base
    )
    assert created is not None
    worktree = Path(created["path"])
    (worktree / "tests").mkdir()
    (worktree / "tests" / "test_y.py").write_text(
        "def test_y():\n    pass\n", encoding="utf-8"
    )
    # WorkPilot's own files never reach the PR.
    (worktree / ".workpilot").mkdir(exist_ok=True)
    (worktree / ".workpilot" / "state.json").write_text("{}", encoding="utf-8")

    code, payload, error = _run(
        temp_git_repo,
        "--action",
        "commit",
        "--spec",
        "003-y",
        "--base-branch",
        base,
        "--message",
        "test: add generated tests",
    )

    assert code == 0, error
    assert payload == {"committed": True, "files": ["tests/test_y.py"]}
    log = subprocess.run(
        ["git", "log", "-1", "--format=%s", "workpilot/003-y"],
        cwd=temp_git_repo,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    assert log == "test: add generated tests"
    assert not (temp_git_repo / "tests").exists()


def test_commit_with_nothing_new_reports_no_commit(temp_git_repo: Path) -> None:
    base = _branch(temp_git_repo)
    _run(temp_git_repo, "--action", "create", "--spec", "004-z", "--base-branch", base)

    code, payload, error = _run(
        temp_git_repo, "--action", "commit", "--spec", "004-z", "--base-branch", base
    )

    assert code == 0, error
    assert payload == {"committed": False, "files": []}


def test_commit_without_a_worktree_fails(temp_git_repo: Path) -> None:
    code, payload, error = _run(
        temp_git_repo, "--action", "commit", "--spec", "005-none"
    )

    assert code == 1
    assert payload is None
    assert "No worktree" in error


def test_a_spec_that_leaves_the_worktree_root_is_refused(temp_git_repo: Path) -> None:
    code, payload, error = _run(
        temp_git_repo, "--action", "create", "--spec", "../escape"
    )

    assert code == 1
    assert payload is None
    assert "Invalid spec_name" in error


def test_a_folder_that_is_not_a_repository_is_refused(tmp_path: Path) -> None:
    folder = tmp_path / "plain"
    folder.mkdir()

    code, payload, error = _run(folder, "--action", "create", "--spec", "006-a")

    assert code == 1
    assert payload is None
    assert "not a git repository" in error


def test_a_commit_without_a_git_identity_says_how_to_fix_it(
    temp_git_repo: Path,
) -> None:
    base = _branch(temp_git_repo)
    _, created, _ = _run(
        temp_git_repo, "--action", "create", "--spec", "007-id", "--base-branch", base
    )
    assert created is not None
    (Path(created["path"]) / "new.txt").write_text("x\n", encoding="utf-8")
    for key in ("user.name", "user.email"):
        subprocess.run(
            ["git", "config", "--unset", key], cwd=temp_git_repo, check=False
        )
    # No guess from the host name either: git must say it does not know.
    subprocess.run(
        ["git", "config", "user.useConfigOnly", "true"], cwd=temp_git_repo, check=True
    )
    env = {k: v for k, v in _git_env(temp_git_repo.parent).items() if "_NAME" not in k}
    env = {k: v for k, v in env.items() if "_EMAIL" not in k}
    proc = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-dir",
            str(temp_git_repo),
            "--action",
            "commit",
            "--spec",
            "007-id",
            "--message",
            "m",
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=120,
    )

    assert proc.returncode == 1
    error = next(
        line[len(ERROR) :]
        for line in proc.stdout.splitlines()
        if line.startswith(ERROR)
    )
    assert "user.name and user.email" in error
