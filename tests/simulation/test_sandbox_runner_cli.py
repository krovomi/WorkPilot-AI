"""The sandbox runner's change review (`--spec-id`), as the desktop app runs it.

It reads `git diff HEAD` of the project and hands back one entry per file,
with its kind of change, its counts and its hunks. The plan rehearsal
(`--spec-dir`) is covered by `test_plan_rehearsal.py`.
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
RUNNER = BACKEND / "runners" / "sandbox_runner.py"


def _git(project: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args], cwd=project, check=True, capture_output=True, text=True
    )


def _run(project: Path, *args: str) -> tuple[int, dict[str, list]]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=120,
        check=False,
    )
    lines: dict[str, list] = {}
    for line in done.stdout.splitlines():
        prefix, sep, payload = line.partition(":")
        if sep and prefix.startswith("SANDBOX_"):
            lines.setdefault(prefix, []).append(json.loads(payload))
    return done.returncode, lines


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "app"
    root.mkdir()
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "dev@example.test")
    _git(root, "config", "user.name", "Dev")
    _git(root, "config", "core.autocrlf", "false")
    (root / "main.txt").write_text("one\ntwo\nthree\n", encoding="utf-8")
    (root / "gone.txt").write_text("bye\n", encoding="utf-8")
    (root / "old-name.txt").write_text("same text\n" * 5, encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "start")
    return root


def test_a_clean_tree_is_complete_with_no_diffs(repo: Path) -> None:
    code, lines = _run(repo, "--spec-id", "012-login")
    assert code == 0
    result = lines["SANDBOX_RESULT"][0]["result"]
    assert result["specId"] == "012-login" and result["mode"] == "changes"
    assert result["phase"] == "complete" and result["diffs"] == []
    assert lines["SANDBOX_EVENT"][-1]["data"] == {
        "files": 0,
        "additions": 0,
        "deletions": 0,
    }


def test_every_kind_of_change_is_reported_with_its_hunks(repo: Path) -> None:
    (repo / "main.txt").write_text("one\n2\nthree\nfour\n", encoding="utf-8")
    (repo / "added.txt").write_text("hello\n", encoding="utf-8")
    _git(repo, "add", "added.txt")
    _git(repo, "rm", "-q", "gone.txt")
    _git(repo, "mv", "old-name.txt", "new-name.txt")

    code, lines = _run(repo)
    assert code == 0, lines
    result = lines["SANDBOX_RESULT"][0]["result"]
    assert result["specId"] == "dry-run"
    assert result["phase"] == "awaiting_approval"
    files = {d["filePath"]: d for d in result["diffs"]}
    assert {p: d["changeType"] for p, d in files.items()} == {
        "added.txt": "added",
        "gone.txt": "deleted",
        "main.txt": "modified",
        "new-name.txt": "renamed",
    }
    main = files["main.txt"]
    assert (main["additions"], main["deletions"]) == (2, 1)
    [hunk] = main["hunks"]
    assert (hunk["oldStart"], hunk["oldCount"]) == (1, 3)
    assert (hunk["newStart"], hunk["newCount"]) == (1, 4)
    assert hunk["content"].splitlines() == [" one", "-two", "+2", " three", "+four"]
    added = files["added.txt"]["hunks"][0]
    # A one-line side has no count in the header: it means one line.
    assert (added["oldStart"], added["oldCount"], added["newCount"]) == (0, 0, 1)
    assert files["gone.txt"]["deletions"] == 1
    assert files["new-name.txt"]["hunks"] == []
    assert lines["SANDBOX_EVENT"][-1]["data"] == {
        "files": 4,
        "additions": 3,
        "deletions": 2,
    }


def test_a_folder_that_is_not_a_repository_is_refused(tmp_path: Path) -> None:
    code, lines = _run(tmp_path)
    assert code == 1
    assert lines["SANDBOX_ERROR"] == ["Project is not a git repository"]


def test_a_repository_without_commits_reports_the_git_error(tmp_path: Path) -> None:
    _git(tmp_path, "init", "-q")
    code, lines = _run(tmp_path)
    assert code == 1
    [message] = lines["SANDBOX_ERROR"]
    assert message.startswith("git diff HEAD failed:")


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    code, lines = _run(tmp_path / "gone")
    assert code == 1
    assert lines["SANDBOX_ERROR"][0].startswith("Project path does not exist:")


def test_a_spec_folder_of_another_project_is_refused(
    repo: Path, tmp_path: Path
) -> None:
    other = tmp_path / "other" / ".workpilot" / "specs" / "001-x"
    other.mkdir(parents=True)
    code, lines = _run(repo, "--spec-dir", str(other))
    assert code == 1
    assert lines["SANDBOX_ERROR"] == ["The spec folder is not a spec of this project"]


def test_lines_before_any_file_header_are_ignored() -> None:
    spec = importlib.util.spec_from_file_location("sandbox_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    stray = "@@ -1 +1 @@\n+orphan\nwarning: something\n"
    assert module._parse_diff(stray) == []
    odd = "diff --git weird\n@@ not a hunk @@\n+x\n"
    assert module._parse_diff(odd) == [
        {
            "filePath": "",
            "changeType": "modified",
            "additions": 0,
            "deletions": 0,
            "hunks": [],
        }
    ]
