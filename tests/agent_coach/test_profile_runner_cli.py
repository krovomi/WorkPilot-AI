"""The style profile runner, run as the Coach page runs it.

A real git project with a task worktree; the profile builder, store and
deviation check are the real ones. No model is involved anywhere.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "coach_profile_runner.py"
SNAKE = {"python": {"naming_functions": "snake_case"}}


def _env() -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    env.update(
        GIT_AUTHOR_NAME="Ana",
        GIT_AUTHOR_EMAIL="ana@example.test",
        GIT_COMMITTER_NAME="Ana",
        GIT_COMMITTER_EMAIL="ana@example.test",
        PYTHONUTF8="1",
        PYTHONIOENCODING="utf-8",
    )
    env.pop("DEFAULT_BRANCH", None)
    return env


def _git(root: Path, *args: str) -> str:
    done = subprocess.run(
        ["git", *args], cwd=root, check=True, capture_output=True, text=True, env=_env()
    )
    return done.stdout.strip()


def _commit(root: Path, files: dict[str, str], message: str = "change") -> None:
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-q", "-m", message)


def _run(root: Path, action: str, *args: str, stdin: str = ""):
    done = subprocess.run(
        [
            sys.executable,
            str(RUNNER),
            "--project-path",
            str(root),
            "--action",
            action,
            *args,
        ],
        cwd=BACKEND,
        env=_env(),
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )
    return done


def _payload(done, prefix: str):
    assert done.returncode == 0, done.stdout + done.stderr
    [line] = [x for x in done.stdout.splitlines() if x.startswith(prefix + ":")]
    return json.loads(line[len(prefix) + 1 :])


def _error(done) -> str:
    assert done.returncode == 1
    [line] = [x for x in done.stdout.splitlines() if x.startswith("COACH_ERROR:")]
    return line[len("COACH_ERROR:") :]


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "commit.gpgsign", "false")
    (root / ".workpilot").mkdir()
    _commit(
        root,
        {
            ".gitignore": ".workpilot/\n",
            "app/users.py": "def load_user(user_id):\n    return user_id\n\n\n"
            "def save_user(user):\n    return user\n",
        },
        "start",
    )
    return root


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    assert _error(_run(tmp_path / "gone", "get")) == "Project path does not exist"


def test_the_profile_is_built_read_and_exported_without_any_identity(
    repo: Path,
) -> None:
    built = _payload(_run(repo, "build"), "COACH_PROFILE")
    read = _payload(_run(repo, "get"), "COACH_PROFILE")
    exported = _payload(_run(repo, "export"), "COACH_EXPORT")

    assert built["profile"] == read["profile"]
    assert set(read) == {"profile", "preferences", "effective", "injected"}
    assert exported["version"] == 1
    text = json.dumps(exported)
    assert "ana@example.test" not in text and str(repo) not in text


def test_a_project_without_its_workpilot_folder_keeps_no_profile(
    tmp_path: Path,
) -> None:
    assert _error(_run(tmp_path, "build")) == "the project has no .workpilot folder"


def test_preferences_and_imports_come_from_stdin_as_data(repo: Path) -> None:
    exported = _payload(
        _run(repo, "set", stdin=json.dumps({"enabled": True, "overrides": SNAKE})),
        "COACH_PROFILE",
    )
    assert exported["effective"] == SNAKE

    other = repo.parent / "other"
    (other / ".workpilot").mkdir(parents=True)
    imported = _payload(
        _run(
            other,
            "import",
            stdin=json.dumps(_payload(_run(repo, "export"), "COACH_EXPORT")),
        ),
        "COACH_PROFILE",
    )
    assert imported["effective"] == SNAKE


@pytest.mark.parametrize(
    ("action", "stdin", "message"),
    [
        ("set", "[1, 2]", "preferences must be an object"),
        ("set", "x" * (256 * 1024 + 1), "input too large"),
        ("set", "{not json", "Expecting property name enclosed in double quotes"),
        ("import", '{"format": "something else"}', "not a WorkPilot coach profile"),
    ],
)
def test_input_that_is_not_a_preference_is_refused(
    repo: Path, action: str, stdin: str, message: str
) -> None:
    assert _error(_run(repo, action, stdin=stdin)).startswith(message)


def _task(repo: Path, spec: str = "001-signup") -> Path:
    worktree = repo / ".workpilot" / "worktrees" / "tasks" / spec
    _git(repo, "worktree", "add", "-q", "-b", f"task/{spec}", str(worktree), "main")
    return worktree


def test_a_task_that_drifts_from_the_style_is_flagged(repo: Path) -> None:
    _run(repo, "set", stdin=json.dumps({"enabled": True, "overrides": SNAKE}))
    worktree = _task(repo)
    _commit(
        worktree,
        {
            # One vote per file: two files lean to camelCase.
            "app/signup.py": "def createAccount(email):\n    return email\n\n\n"
            "def checkEmail(email):\n    return email\n",
            "app/mail.py": "def sendWelcome(email):\n    return email\n\n\n"
            "def sendReminder(email):\n    return email\n",
        },
    )
    _git(worktree, "rm", "-q", "app/users.py")
    _git(worktree, "commit", "-q", "-m", "drop users")

    check = _payload(_run(repo, "check", "--spec", "001-signup"), "COACH_CHECK")

    assert check["spec"] == "001-signup"
    assert check["deviations"] == [
        {
            "language": "python",
            "dimension": "naming_functions",
            "expected": "snake_case",
            "found": "camelCase",
            "count": 2,
        }
    ]


def test_a_task_without_a_worktree_or_a_base_cannot_be_checked(repo: Path) -> None:
    assert _error(_run(repo, "check", "--spec", "009-none")) == (
        "this task has no worktree"
    )

    stray = repo / ".workpilot" / "worktrees" / "tasks" / "010-stray"
    stray.mkdir(parents=True)
    _git(stray, "init", "-q", "-b", "elsewhere")
    _git(stray, "config", "commit.gpgsign", "false")
    _commit(stray, {"x.py": "x = 1\n"})

    assert _error(_run(repo, "check", "--spec", "010-stray")) == (
        "the task's base branch was not found"
    )


def test_the_diff_read_for_a_check_is_bounded(repo: Path, monkeypatch) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("coach_profile_runner_t", RUNNER)
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    monkeypatch.setattr(runner, "MAX_FILES", 1)
    monkeypatch.delenv("DEFAULT_BRANCH", raising=False)
    worktree = _task(repo, "002-many")
    _commit(worktree, {"a.py": "a = 1\n", "b.py": "b = 2\n"})

    assert runner._task_diff(repo, "002-many") == {"a.py": ["a = 1"]}
