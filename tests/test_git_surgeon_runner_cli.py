"""The Git Surgeon runner, as the desktop app starts it, on a real repository.

The scan flags messy commits, `--plan` plans a reword of the branch,
`--apply` replays that plan on a new branch, `--branches` and
`--delete-branches` tidy the merged ones, `--history` counts applied plans.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "git_surgeon_runner.py"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def _commit(repo: Path, name: str, text: str, message: str) -> None:
    (repo / name).write_text(text, encoding="utf-8")
    _git(repo, "add", name)
    _git(repo, "commit", "-qm", message)


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    root.mkdir()
    _git(root, "init", "-q", "-b", "main")
    _git(root, "config", "user.email", "dev@example.test")
    _git(root, "config", "user.name", "Dev")
    _git(root, "config", "commit.gpgsign", "false")
    _commit(root, "a.txt", "a\n", "feat: start")
    _commit(root, "b.txt", "b\n", "wip")
    _git(root, "checkout", "-q", "-b", "old")
    _commit(root, "o.txt", "o\n", "feat: old work")
    _git(root, "checkout", "-q", "main")
    _git(root, "merge", "-q", "--no-ff", "old", "-m", "merge old")
    _git(root, "checkout", "-q", "-b", "feature")
    _commit(root, "a.txt", "a\nmore\n", "wip 2")
    return root


def _run(project: Path, *args: str) -> tuple[int, dict[str, list]]:
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env=env,
        timeout=180,
        check=False,
    )
    lines: dict[str, list] = {}
    for line in done.stdout.splitlines():
        prefix, sep, payload = line.partition(":")
        if not sep:
            continue
        if prefix.startswith("GIT_SURGEON_"):
            lines.setdefault(prefix, []).append(json.loads(payload))
    return done.returncode, lines


def test_the_scan_flags_the_messy_commits(repo: Path) -> None:
    code, lines = _run(repo, "--max-commits", "50")
    assert code == 0
    [result] = lines["GIT_SURGEON_RESULT"]
    messy = [i for i in result["issues"] if i["issueType"] == "messy_commits"]
    assert sorted(i["description"] for i in messy) == [
        "Messy commit message: 'wip 2'",
        "Messy commit message: 'wip'",
    ]
    assert all(len(i["commitSha"]) == 40 for i in messy)
    assert {a["action"] for a in result["actions"]} == {"squash"}
    assert [e["type"] for e in lines["GIT_SURGEON_EVENT"]] == ["start", "complete"]


def test_a_folder_that_is_not_a_repository_has_nothing_to_fix(tmp_path: Path):
    code, lines = _run(tmp_path)
    assert code == 0
    assert (
        lines["GIT_SURGEON_RESULT"][0]["summary"] == "Project is not a git repository"
    )


def test_a_plan_is_replayed_on_a_new_branch(repo: Path, tmp_path: Path) -> None:
    code, lines = _run(repo, "--plan", "--base", "main")
    assert code == 0, lines
    [plan] = lines["GIT_SURGEON_RESULT"]
    assert plan["branch"] == "feature"
    assert [c["subject"] for c in plan["commits"]] == ["wip 2"]
    [step] = plan["plan"]
    assert step["kind"] == "reword" and step["message"] != "wip 2"

    plan_file = tmp_path / "plan.json"
    plan_file.write_text(
        json.dumps({**plan, "branch": "feature-clean"}), encoding="utf-8"
    )
    code, lines = _run(repo, "--apply", str(plan_file))
    assert code == 0, lines
    assert _git(repo, "log", "-1", "--format=%s", "feature-clean") == step["message"]
    assert _git(repo, "log", "-1", "--format=%s", "feature") == "wip 2"

    code, lines = _run(repo, "--history")
    assert code == 0
    [month] = lines["GIT_SURGEON_RESULT"][0]["months"]
    assert month["month"]


def test_merged_branches_are_listed_and_deleted(repo: Path, tmp_path: Path) -> None:
    code, lines = _run(repo, "--branches")
    assert code == 0
    listing = {b["name"]: b for b in lines["GIT_SURGEON_RESULT"][0]["branches"]}
    assert listing["old"]["merged"] is True
    assert listing["feature"]["current"] is True

    names = tmp_path / "names.json"
    names.write_text(json.dumps(["old", "feature", "ghost"]), encoding="utf-8")
    code, lines = _run(repo, "--delete-branches", str(names))
    assert code == 0
    assert lines["GIT_SURGEON_RESULT"] == [
        {"deleted": ["old"], "refused": {"feature": "in_use", "ghost": "unknown"}}
    ]
    assert "old" not in _git(repo, "branch", "--format=%(refname:short)").split()


@pytest.mark.parametrize(
    ("content", "message"),
    [
        (None, "the input file is missing or too big"),
        ("[1]", "the plan file holds no plan"),
    ],
)
def test_a_plan_file_must_hold_a_plan(repo, tmp_path, content, message) -> None:
    plan_file = tmp_path / "plan.json"
    if content is not None:
        plan_file.write_text(content, encoding="utf-8")
    code, lines = _run(repo, "--apply", str(plan_file))
    assert code == 1
    assert lines["GIT_SURGEON_ERROR"] == [message]


def test_a_branch_list_that_is_not_a_list_is_refused(repo, tmp_path) -> None:
    names = tmp_path / "names.json"
    names.write_text('{"old": true}', encoding="utf-8")
    code, lines = _run(repo, "--delete-branches", str(names))
    assert code == 1 and lines["GIT_SURGEON_ERROR"] == ["no branch list"]


@pytest.mark.parametrize("count", ["0", "5001"])
def test_max_commits_is_bounded(repo: Path, count: str) -> None:
    code, lines = _run(repo, "--max-commits", count)
    assert code == 1
    assert lines["GIT_SURGEON_ERROR"] == ["--max-commits must be between 1 and 5000"]


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    code, lines = _run(tmp_path / "gone")
    assert code == 1
    assert lines["GIT_SURGEON_ERROR"][0].startswith("Project path does not exist:")


def test_an_unexpected_failure_still_ends_with_an_error_line(
    repo: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("git_surgeon_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def boom(_repo):
        raise LookupError("index is locked")

    monkeypatch.setattr(module, "list_branches", boom)
    monkeypatch.setattr(
        sys, "argv", ["runner", "--project-path", str(repo), "--branches"]
    )
    with pytest.raises(SystemExit) as stop:
        module.main()
    assert stop.value.code == 1
    assert capsys.readouterr().out.splitlines()[-1] == (
        'GIT_SURGEON_ERROR:"index is locked"'
    )
