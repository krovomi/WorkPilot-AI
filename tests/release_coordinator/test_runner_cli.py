"""The Release Coordinator runner, started the way the desktop app starts it.

`python runners/release_coordinator_runner.py --project-path <dir> [mode]`
prints events, then one RESULT or ERROR line. These tests drive every mode on
a real git repository with two services, and check what the app reads back.
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
RUNNER = BACKEND / "runners" / "release_coordinator_runner.py"


def _git(project: Path, *args: str) -> None:
    subprocess.run(
        ["git", *args], cwd=project, check=True, capture_output=True, text=True
    )


def _clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    """Two npm services: `api` 1.2.3 and `web` 0.1.0-beta.1, which depends on it."""
    root = tmp_path / "shop"
    (root / "api").mkdir(parents=True)
    (root / "web").mkdir()
    (root / "api" / "package.json").write_text(
        json.dumps({"name": "api", "version": "1.2.3"}), encoding="utf-8"
    )
    (root / "web" / "package.json").write_text(
        json.dumps({"name": "web", "version": "0.1.0-beta.1"}), encoding="utf-8"
    )
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "dev@example.test")
    _git(root, "config", "user.name", "Dev")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "feat: first version")
    (root / "api" / "handler.txt").write_text("fixed\n", encoding="utf-8")
    _git(root, "add", ".")
    _git(root, "commit", "-qm", "fix: the api answered 500")
    return root


def _run(project: Path, *args: str) -> tuple[int, list[tuple[str, object]]]:
    done = subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project), *args],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        env=_clean_env(),
        timeout=120,
        check=False,
    )
    lines = []
    for line in done.stdout.splitlines():
        prefix, sep, payload = line.partition(":")
        if sep and prefix.startswith("RELEASE_COORDINATOR_"):
            lines.append((prefix, json.loads(payload)))
    return done.returncode, lines


def _result(lines: list[tuple[str, object]]) -> dict:
    found = [p for k, p in lines if k == "RELEASE_COORDINATOR_RESULT"]
    assert len(found) == 1, lines
    return found[0]  # type: ignore[return-value]


def _error(lines: list[tuple[str, object]]) -> str:
    found = [p for k, p in lines if k == "RELEASE_COORDINATOR_ERROR"]
    assert len(found) == 1, lines
    return found[0]  # type: ignore[return-value]


def _semver(v: dict) -> str:
    text = f"{v['major']}.{v['minor']}.{v['patch']}"
    return text + (f"-{v['prerelease']}" if v["prerelease"] else "")


def test_the_plan_bumps_each_service_from_its_own_commits(project: Path) -> None:
    code, lines = _run(project)
    assert code == 0
    events = [p for k, p in lines if k == "RELEASE_COORDINATOR_EVENT"]
    assert [e["type"] for e in events] == ["start", "progress", "complete"]
    assert events[1]["data"]["status"] == "Found 2 service(s), analyzing commits..."
    plan = _result(lines)
    services = {s["name"]: s for s in plan["services"]}
    # api saw a feat and a fix, web only the feat: both are minor bumps,
    # and a prerelease leaves its suffix behind.
    assert _semver(services["api"]["currentVersion"]) == "1.2.3"
    assert _semver(services["api"]["nextVersion"]) == "1.3.0"
    assert services["api"]["changelogEntries"] == [
        "- the api answered 500 (fix)",
        "- first version (feat)",
    ]
    assert _semver(services["web"]["nextVersion"]) == "0.2.0"
    assert services["web"]["changelogEntries"] == ["- first version (feat)"]
    assert plan["status"] == "planning"
    assert "api: 1.2.3 → 1.3.0" in plan["summary"]
    assert plan["createdAt"].endswith("+00:00")


def test_a_folder_without_manifests_gets_an_empty_plan(tmp_path: Path) -> None:
    code, lines = _run(tmp_path)
    assert code == 0
    plan = _result(lines)
    assert plan["id"] == "release-empty"
    assert plan["services"] == [] and plan["allGatesPassed"] is True


def test_release_notes_are_written_from_the_plan_without_ai(project: Path) -> None:
    code, lines = _run(project, "--notes")
    assert code == 0
    notes = _result(lines)
    assert notes["by"] == "rules"
    assert "## api 1.2.3 → 1.3.0 (minor)" in notes["markdown"]
    assert "### Fixes\n- the api answered 500" in notes["markdown"]


def test_history_modes_answer_on_a_project_that_never_ran_a_train(
    project: Path,
) -> None:
    assert _result(_run(project, "--runs")[1]) == {"runs": []}
    assert _result(_run(project, "--metrics")[1]) == {"months": []}
    code, lines = _run(project, "--run", "nope")
    assert code == 1 and _error(lines) == "not a run id"


def test_train_modes_need_a_train_file(project: Path) -> None:
    code, lines = _run(project, "--train")
    assert code == 1
    assert _error(lines) == "the project has no release-train.yaml"


def test_a_train_is_started_listed_reloaded_and_aborted(project: Path) -> None:
    (project / "release-train.yaml").write_text(
        "services:\n"
        "  - name: api\n"
        "    deploy: {command: [git, --version]}\n"
        "  - name: web\n"
        "    deploy: {command: [git, --version]}\n",
        encoding="utf-8",
    )
    page = _result(_run(project, "--train")[1])
    sha = page["sha256"]
    assert page["runs"] == [] and "calendar" in page

    code, lines = _run(
        project,
        "--start",
        "staging",
        "--services",
        "api",
        "--express",
        "--approved-hash",
        sha,
    )
    assert code == 0, lines
    run = _result(lines)
    assert run["environment"] == "staging" and run["express"] is True
    assert [i["service"] for i in run["items"]] == ["api"]
    assert run["items"][0]["version"] == "1.3.0"
    assert run["items"][0]["previousVersion"] == "1.2.3"

    listed = _result(_run(project, "--runs")[1])["runs"]
    assert [r["id"] for r in listed] == [run["id"]]
    assert _result(_run(project, "--run", run["id"])[1])["id"] == run["id"]

    code, lines = _run(
        project, "--advance", run["id"], "--action", "abort", "--approved-hash", sha
    )
    assert code == 0, lines
    assert _result(lines)["status"] == "aborted"
    months = _result(_run(project, "--metrics")[1])["months"]
    assert months[0]["trains"] == 1


def test_an_edited_train_file_stops_an_advance(project: Path) -> None:
    (project / "release-train.yaml").write_text(
        "services:\n  - name: api\n", encoding="utf-8"
    )
    code, lines = _run(project, "--advance", "rt-x", "--approved-hash", "f" * 64)
    assert code == 1
    assert _error(lines).startswith("not_approved")


@pytest.mark.parametrize("count", ["0", "5001"])
def test_max_commits_is_bounded(project: Path, count: str) -> None:
    code, lines = _run(project, "--max-commits", count)
    assert code == 1
    assert _error(lines) == "--max-commits must be from 1 to 5000"


def test_a_missing_project_folder_is_refused(tmp_path: Path) -> None:
    code, lines = _run(tmp_path / "gone")
    assert code == 1
    assert _error(lines) == "the project folder does not exist"


# --- in-process: the edges a real repository does not reach ----------------------


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("release_runner_under_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_git_log_falls_back_to_the_whole_repo_for_an_outside_path(
    runner, project: Path, tmp_path: Path
) -> None:
    subjects = runner._git_log_for_path(project, tmp_path / "elsewhere", 10)
    assert subjects == ["fix: the api answered 500", "feat: first version"]


def test_git_log_is_empty_without_git_or_outside_a_repository(
    runner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert runner._git_log_for_path(tmp_path, tmp_path, 10) == []

    def no_git(*_a, **_k):
        raise FileNotFoundError("git")

    monkeypatch.setattr(runner.subprocess, "run", no_git)
    assert runner._git_log_for_path(tmp_path, tmp_path, 10) == []


def test_a_service_outside_the_project_is_left_out_of_the_train(
    runner, project: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (project / "release-train.yaml").write_text(
        "services:\n  - name: api\n", encoding="utf-8"
    )
    outside = tmp_path / "vendor"
    monkeypatch.setattr(
        runner,
        "discover_services",
        lambda root: [
            (root, {"name": "root-app", "dependencies": ["api"]}),
            (outside, {"name": "vendored"}),
        ],
    )
    ctx = runner._context(project)
    assert ctx.folders == {"root-app": ""}
    assert ctx.manifest_deps == {"root-app": ["api"]}


def test_a_filesystem_error_is_reported_shortly(
    runner, project: Path, monkeypatch: pytest.MonkeyPatch, capsys
) -> None:
    def broken(_root):
        raise PermissionError("denied " + "x" * 600)

    monkeypatch.setattr(runner, "discover_services", broken)
    monkeypatch.setattr(sys, "argv", ["runner", "--project-path", str(project)])
    with pytest.raises(SystemExit) as stop:
        runner.main()
    assert stop.value.code == 1
    line = capsys.readouterr().out.splitlines()[-1]
    prefix, _, payload = line.partition(":")
    assert prefix == "RELEASE_COORDINATOR_ERROR"
    message = json.loads(payload)
    assert message.startswith("PermissionError: denied") and len(message) == 400
