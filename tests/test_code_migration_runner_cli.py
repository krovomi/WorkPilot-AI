"""The code migration runner as the Code Migration page starts it.

A real project and the real migration orchestrator: the runner analyses and
plans; the change itself is a Kanban task, so nothing in the project moves.
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
RUNNER = BACKEND / "runners" / "code_migration_runner.py"
RESULT = "__MIGRATION_RESULT__:"
COMPONENT = """import React from "react";

export class Counter extends React.Component {
  state = { count: 0 };
  render() {
    return <button>{this.state.count}</button>;
  }
}
"""


def _process(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), *args],
        cwd=BACKEND,
        # As the app starts it (pythonRunnerEnv): UTF-8 whatever the code page.
        env={**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"},
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def _result(out: str) -> dict:
    [line] = [x for x in out.splitlines() if x.startswith(RESULT)]
    return json.loads(line[len(RESULT) :])


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "shop"
    (root / "src").mkdir(parents=True)
    (root / "package.json").write_text(
        json.dumps({"name": "shop", "dependencies": {"react": "18.2.0"}}),
        encoding="utf-8",
    )
    (root / "src" / "Counter.jsx").write_text(COMPONENT, encoding="utf-8")
    return root


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    done = _process(
        "--project-dir", str(tmp_path / "gone"), "--migration-description", "x"
    )

    assert done.returncode == 1
    assert "Project directory not found" in done.stdout


@pytest.mark.parametrize("dry_run", [True, False])
def test_a_migration_is_planned_and_handed_to_a_task(
    project: Path, dry_run: bool
) -> None:
    args = [
        "--project-dir",
        str(project),
        "--migration-description",
        "Migrate React Class Components to Hooks",
        "--thinking-level",
        "low",
        "--batch-size",
        "5",
    ]
    done = _process(*args, *(["--dry-run"] if dry_run else []))

    assert done.returncode == 0, done.stdout + done.stderr
    result = _result(done.stdout)
    assert result["status"] == "success"
    assert result["plan"]["target"] == "react-hooks / auto"
    assert "javascript" in result["plan"]["source"].lower()
    expected = "dry_run" if dry_run else "not_run"
    assert result["execution"]["status"] == expected
    assert result["summary"]["files_modified"] == 0
    # Planning never touches the project's files.
    assert (project / "src" / "Counter.jsx").read_text("utf-8") == COMPONENT
    assert ("Dry run mode" in done.stdout) is dry_run


def test_a_pair_the_planner_knows_gets_a_real_plan(tmp_path: Path) -> None:
    root = tmp_path / "api"
    root.mkdir()
    (root / "requirements.txt").write_text("flask==3.0\n", encoding="utf-8")
    (root / "app.py").write_text(
        "from flask import Flask\n\napp = Flask(__name__)\n", encoding="utf-8"
    )

    done = _process(
        "--project-dir",
        str(root),
        "--migration-description",
        "Move from Flask to FastAPI",
        "--dry-run",
    )

    assert done.returncode == 0, done.stdout + done.stderr
    result = _result(done.stdout)
    assert result["plan"]["migration_id"] != "fallback"
    assert "note" not in result["plan"]
    assert result["plan"]["target"] == "fastapi / auto"
    assert "python" in result["plan"]["source"].lower()
    assert result["summary"]["plan_status"] == "ready"
    assert "Migration start warning" not in done.stdout
    # The page shows the plan and hands it to the Kanban task.
    phases = result["plan"]["phases"]
    assert [phase["name"] for phase in phases][0] == "Analysis"
    assert all(phase["steps"] for phase in phases)
    assert result["plan"]["total_steps"] == sum(len(p["steps"]) for p in phases)
    assert result["plan"]["risk_level"] in {"low", "medium"}


def test_a_react_app_moved_to_typescript_gets_the_typescript_plan(project) -> None:
    done = _process(
        "--project-dir",
        str(project),
        "--migration-description",
        "Convert JavaScript files to TypeScript",
        "--dry-run",
    )

    assert done.returncode == 0, done.stdout + done.stderr
    result = _result(done.stdout)
    assert result["summary"]["plan_status"] == "ready"
    names = [phase["name"] for phase in result["plan"]["phases"]]
    assert "JavaScript to TypeScript" in names


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("code_migration_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _main(runner, monkeypatch, project: Path) -> int | None:
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "code_migration_runner.py",
            "--project-dir",
            str(project),
            "--migration-description",
            "Convert this JS module to TypeScript",
        ],
    )
    try:
        runner.main()
    except SystemExit as stop:
        return stop.code
    return None


@pytest.mark.parametrize(
    ("error", "message"),
    [
        (KeyboardInterrupt(), "Migration interrupted."),
        (OSError("disk full"), "Fatal error: disk full"),
    ],
)
def test_a_run_that_stops_says_why(
    runner, monkeypatch, project, capsys, error, message
) -> None:
    def stop(self):
        raise error

    monkeypatch.setattr(runner.CodeMigrationRunner, "run_migration", stop)

    assert _main(runner, monkeypatch, project) == 1
    assert message in capsys.readouterr().out


def test_a_pair_the_planner_does_not_know_is_unsupported_not_failed(
    runner, monkeypatch, project, capsys
) -> None:
    from migration.orchestrator import MigrationOrchestrator

    def unknown(self, **_targets):
        raise ValueError("no rule for javascript -> cobol")

    monkeypatch.setattr(MigrationOrchestrator, "start_migration", unknown)
    migration = runner.CodeMigrationRunner(str(project), "Rewrite it in COBOL")

    result = migration.run_migration()  # sets itself up when asked to run

    assert result["plan"]["migration_id"] == "fallback"
    assert result["plan"]["note"] == "no rule for javascript -> cobol"
    assert result["summary"]["plan_status"] == "unsupported"
    assert "phases" not in result["plan"]  # no rule-based plan to show
    assert "Migration start warning" in capsys.readouterr().out


@pytest.mark.parametrize(
    ("description", "framework", "language"),
    [
        ("Port the service to Go", None, "go"),
        ("Use Google fonts", None, None),
        ("Upgrade to Python 3.11", "python3.12", "python"),
        # The longer name at the same place: ASP.NET, not .NET.
        ("Move to ASP.NET in C#", "aspnetcore", "csharp"),
        ("Upgrade to .NET 10", "dotnet", None),
        # The target is the stack named last.
        ("Migrate from React to Vue 3", "vue", None),
        ("Migrate React Class Components to Hooks", "react-hooks", None),
        ("Convert the Java classes to Kotlin", None, "kotlin"),
        ("Convert JavaScript files to TypeScript", "typescript", "typescript"),
        ("Move to Python 3.12", "python3.12", "python"),
        ("Move from MySQL to Postgres", "postgresql", None),
        # Brackets give a detail; they name the target only when nothing else does.
        ("Upgrade Spring Boot 2 to 3 (javax to jakarta)", "spring-boot", None),
        ("Upgrade the app (to Vue 3)", "vue", None),
    ],
)
def test_the_target_is_read_from_the_description(
    runner, project, description, framework, language
) -> None:
    migration = runner.CodeMigrationRunner(str(project), description)

    assert migration._parse_migration_description() == (framework, language)
