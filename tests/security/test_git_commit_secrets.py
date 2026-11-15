"""The secrets scan of a `git commit` an agent runs, in a real repository.

It scans what the commit will hold, in the repository the commit happens in:
the project the hooks were given, moved by `-C` or `--work-tree` as git
moves it, and the tracked changes `commit -a` stages on its way.
"""

from __future__ import annotations

import subprocess

import pytest
from security.constants import PROJECT_DIR_ENV_VAR
from security.git_validators import _commits_all, validate_git_command

FAKE_AWS_KEY = "AKIA" + "Q7ZXR4MW2PLK9VBN"
LEAK = f'AWS_ACCESS_KEY_ID = "{FAKE_AWS_KEY}"\n'


def _git(repo, *args):
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


@pytest.fixture
def elsewhere(tmp_path, monkeypatch):
    """The backend runs from another folder than the project."""
    other = tmp_path / "backend"
    other.mkdir()
    monkeypatch.chdir(other)
    monkeypatch.delenv(PROJECT_DIR_ENV_VAR, raising=False)
    return other


@pytest.fixture
def staged_leak(temp_git_repo):
    (temp_git_repo / "keys.py").write_text(LEAK, encoding="utf-8")
    _git(temp_git_repo, "add", "keys.py")
    return temp_git_repo


def test_a_commit_in_the_project_given_to_the_hooks_is_scanned(
    staged_leak, elsewhere, monkeypatch
):
    monkeypatch.setenv(PROJECT_DIR_ENV_VAR, str(staged_leak))

    ok, message = validate_git_command("git commit -m 'add keys'")

    assert ok is False
    assert message.startswith("SECRETS DETECTED - COMMIT BLOCKED")
    assert "File: keys.py" in message
    assert FAKE_AWS_KEY not in message


@pytest.mark.parametrize(
    "command",
    [
        "git -C {repo} commit -m x",
        "git -C {parent} -C repo commit -m x",
        "git --work-tree={repo} --git-dir={repo}/.git commit -m x",
        "git -c core.quotepath=off -C {repo} commit -m x",
    ],
)
def test_global_options_move_the_scan_with_the_commit(staged_leak, elsewhere, command):
    line = command.format(
        repo=staged_leak.as_posix(), parent=staged_leak.parent.as_posix()
    )

    ok, message = validate_git_command(line)

    assert ok is False, line
    assert "File: keys.py" in message


def test_commit_all_scans_the_tracked_changes_it_stages(temp_git_repo, elsewhere):
    (temp_git_repo / "app.py").write_text("x = 1\n", encoding="utf-8")
    _git(temp_git_repo, "add", "app.py")
    _git(temp_git_repo, "commit", "-q", "-m", "app")
    (temp_git_repo / "app.py").write_text(LEAK, encoding="utf-8")
    repo = temp_git_repo.as_posix()

    assert validate_git_command(f"git -C {repo} commit -m wip")[0] is True
    for line in (
        f"git -C {repo} commit -am wip",
        f"git -C {repo} commit --all -m wip",
        f"git -C {repo} commit -a -m wip",
    ):
        ok, message = validate_git_command(line)
        assert ok is False, line
        assert "File: app.py" in message


def test_a_clean_commit_and_an_empty_one_pass(temp_git_repo, elsewhere):
    repo = temp_git_repo.as_posix()
    assert validate_git_command(f"git -C {repo} commit -m nothing") == (True, "")

    (temp_git_repo / "ok.py").write_text("x = 1\n", encoding="utf-8")
    _git(temp_git_repo, "add", "ok.py")
    assert validate_git_command(f"git -C {repo} commit -m ok") == (True, "")


def test_other_subcommands_are_not_scanned(staged_leak, elsewhere):
    repo = staged_leak.as_posix()
    assert validate_git_command(f"git -C {repo} status") == (True, "")
    assert validate_git_command(f"git -C {repo}") == (True, "")


@pytest.mark.parametrize(
    ("args", "expected"),
    [
        (["-am", "x"], True),
        (["-va"], True),
        (["--all"], True),
        (["-m", "a"], False),
        (["-ma"], False),
        (["--amend", "-m", "x"], False),
        (["--", "-a"], False),
        ([], False),
    ],
)
def test_which_commit_flags_stage_everything(args, expected):
    assert _commits_all(args) is expected


def test_the_index_is_what_is_scanned_not_the_working_tree(temp_git_repo, elsewhere):
    """A commit holds what was staged: the file as `git add` saw it."""
    repo = temp_git_repo.as_posix()
    (temp_git_repo / "conf.py").write_text(LEAK, encoding="utf-8")
    _git(temp_git_repo, "add", "conf.py")
    (temp_git_repo / "conf.py").write_text("x = 1\n", encoding="utf-8")
    assert validate_git_command(f"git -C {repo} commit -m staged")[0] is False

    (temp_git_repo / "conf.py").write_text(LEAK, encoding="utf-8")
    _git(temp_git_repo, "rm", "-q", "--cached", "conf.py")
    (temp_git_repo / "clean.py").write_text("y = 2\n", encoding="utf-8")
    _git(temp_git_repo, "add", "clean.py")
    assert validate_git_command(f"git -C {repo} commit -m clean") == (True, "")
