"""runners/github/runner.py, started the way the desktop app starts it.

`python runners/github/runner.py --project <p> <command>` from `apps/backend`,
with no PYTHONPATH, against a fake `gh` (tests/gh_fake.py) that answers the
commands and records them. These are the commands that need GitHub and no
model; the ones that call a model are driven in test_runner_commands.py with
a stand-in orchestrator.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from gh_fake import write_fake_gh  # noqa: E402

BACKEND = Path(__file__).resolve().parents[3] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "github" / "runner.py"

ISSUE = {
    "body": "",
    "author": {"login": "ann"},
    "createdAt": "2026-11-01T00:00:00Z",
    "updatedAt": "2026-11-01T00:00:00Z",
    "comments": [],
}
ISSUES = [
    {**ISSUE, "number": 5, "title": "Crash on save", "labels": [{"name": "auto-fix"}]},
    {**ISSUE, "number": 6, "title": "Typo", "labels": []},
]
ANSWERS = {
    "--version": {"stdout": "gh version 2.80.0\n"},
    "auth token": {"stdout": "t0k\n"},
    "repo view": {"stdout": "own/repo\n"},
    "issue list": {"stdout": json.dumps(ISSUES)},
}


@pytest.fixture
def project(tmp_path):
    project = tmp_path / "project"
    project.mkdir()
    return project


@pytest.fixture
def gh(tmp_path):
    return write_fake_gh(tmp_path / "gh", dict(ANSWERS))


def _run(
    project: Path, gh, *argv: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess:
    clean = {
        k: v
        for k, v in os.environ.items()
        if k
        not in (
            "PYTHONPATH",
            "GITHUB_TOKEN",
            "GITHUB_BOT_TOKEN",
            "GITHUB_REPO",
            "DEBUG",
        )
    }
    clean["GITHUB_CLI_PATH"] = str(gh.path)
    clean.update(env or {})
    return subprocess.run(
        [sys.executable, str(RUNNER), "--project", str(project), *argv],
        cwd=BACKEND,
        env=clean,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )


def _seed_autofix(project: Path, number: int, status: str, **extra) -> None:
    issues = project / ".workpilot" / "github" / "issues"
    issues.mkdir(parents=True, exist_ok=True)
    state = {
        "issue_number": number,
        "issue_url": f"https://github.com/own/repo/issues/{number}",
        "repo": "own/repo",
        "status": status,
        "created_at": f"2026-11-0{number % 9 + 1}T00:00:00",
        "updated_at": "2026-11-10T00:00:00",
        **extra,
    }
    (issues / f"autofix_{number}.json").write_text(json.dumps(state), encoding="utf-8")


def test_without_a_command_prints_the_commands_and_fails(project, gh):
    done = _run(project, gh)
    assert done.returncode == 1
    assert "review-pr" in done.stdout
    assert "approve-batches" in done.stdout


def test_takes_the_token_from_gh_and_the_repo_from_the_project(project, gh):
    done = _run(project, gh, "queue")
    assert done.returncode == 0, done.stderr
    assert "Queue is empty." in done.stdout
    asked = [call[:2] for call in gh.calls()]
    assert ["auth", "token"] in asked
    assert ["repo", "view"] in asked


def test_an_explicit_token_and_repo_ask_gh_for_neither(project, gh):
    done = _run(project, gh, "--token", "given", "--repo", "a/b", "queue")
    assert done.returncode == 0, done.stderr
    asked = [call[:2] for call in gh.calls()]
    assert ["auth", "token"] not in asked
    assert ["repo", "view"] not in asked


def test_falls_back_to_github_repo_when_the_project_has_no_remote(project, gh):
    gh.answer({**ANSWERS, "repo view": {"stderr": "no git remotes found", "code": 1}})
    done = _run(project, gh, "queue", env={"GITHUB_REPO": "env/repo", "DEBUG": "1"})
    assert done.returncode == 0, done.stderr
    assert "[DEBUG] gh repo view failed: no git remotes found" in done.stdout


def test_no_token_anywhere_is_an_error(project, gh):
    gh.answer({**ANSWERS, "auth token": {"stderr": "not logged in", "code": 1}})
    done = _run(project, gh, "queue")
    assert done.returncode == 1
    assert "Error: No GitHub token found" in done.stdout


def test_no_repo_anywhere_is_an_error(project, gh):
    gh.answer({**ANSWERS, "repo view": {"code": 1}})
    done = _run(project, gh, "queue")
    assert done.returncode == 1
    assert "Error: No GitHub repo found" in done.stdout


def test_the_queue_lists_each_issue_with_its_state(project, gh):
    _seed_autofix(project, 12, "pr_created", pr_number=40)
    _seed_autofix(
        project,
        13,
        "failed",
        error="The build broke while compiling the parser module twice",
    )
    # A state the list has no mark for yet.
    _seed_autofix(project, 14, "merge_conflict")
    done = _run(project, gh, "queue")
    assert done.returncode == 0, done.stderr
    out = done.stdout
    assert "Auto-Fix Queue (3 items)" in out
    assert "[+++] #12: pr_created" in out
    assert "PR: #40" in out
    assert "[ERR] #13: failed" in out
    assert "Error: The build broke while compiling the parser module ..." in out
    assert "[???] #14: merge_conflict" in out


def test_check_new_prints_the_issues_not_yet_queued_as_json(project, gh):
    _seed_autofix(project, 5, "pending")
    done = _run(project, gh, "check-new")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout.split("JSON Output", 1)[1]) == [{"number": 6}]


def test_check_labels_lists_an_issue_a_maintainer_labelled(project, gh):
    gh.answer(
        {
            **ANSWERS,
            "api /repos/own/repo/issues/5/events?per_page=100&page=1": {
                "stdout": json.dumps(
                    [
                        {
                            "event": "labeled",
                            "label": {"name": "auto-fix"},
                            "actor": {"login": "ann"},
                        }
                    ]
                )
            },
            "api /repos/own/repo/collaborators/ann/permission": {
                "stdout": json.dumps({"permission": "admin"})
            },
            "api /repos/own/repo": {
                "stdout": json.dumps({"owner": {"login": "own", "type": "User"}})
            },
        }
    )
    done = _run(project, gh, "check-auto-fix-labels")
    assert done.returncode == 0, done.stderr
    assert "Found 1 issues with auto-fix labels:" in done.stdout
    assert "#5 (auto-fix) Crash on save" in done.stdout


def test_check_labels_skips_a_label_it_cannot_trace(project, gh):
    done = _run(project, gh, "check-auto-fix-labels")
    assert done.returncode == 0, done.stderr
    assert "[PERMISSION] Error checking #5" in done.stdout
    assert "No issues with auto-fix labels found." in done.stdout


def test_batch_status_starts_at_zero(project, gh):
    done = _run(project, gh, "batch-status")
    assert done.returncode == 0, done.stderr
    assert "Total batches: 0" in done.stdout
    assert "Failed: 0" in done.stdout


def test_approve_batches_reads_its_file(project, gh, tmp_path):
    missing = _run(project, gh, "approve-batches", str(tmp_path / "missing.json"))
    assert missing.returncode == 1
    assert "Error loading batch file" in missing.stdout

    empty = tmp_path / "empty.json"
    empty.write_text("[]", encoding="utf-8")
    done = _run(project, gh, "approve-batches", str(empty))
    assert done.returncode == 0, done.stderr
    assert "No batches in file to approve." in done.stdout


def test_a_failing_gh_call_ends_the_command_with_its_error(project, gh):
    gh.answer({**ANSWERS, "issue list": {"stderr": "HTTP 502", "code": 1}})
    done = _run(project, gh, "check-new")
    assert done.returncode == 1
    assert "Error: " in done.stdout
    assert "Traceback" in done.stderr
