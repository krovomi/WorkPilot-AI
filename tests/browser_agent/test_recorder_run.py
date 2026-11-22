"""A recorded test runs in its review card's worktree, with its format's
runner, without a shell; its first run is counted in the project."""

from __future__ import annotations

import importlib.util
import json
import subprocess
from pathlib import Path

import pytest
from browser_agent import recorder_run
from browser_agent.recorder_run import (
    RUNS_FILE,
    command_for,
    locate_test,
    record_first_run,
    run_recorded_test,
)

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "browser_recorder_runner.py"


def _worktree(tmp_path: Path, rel: str, code: str = "test()") -> Path:
    root = tmp_path / "wt"
    (root / rel).parent.mkdir(parents=True, exist_ok=True)
    (root / rel).write_text(code, encoding="utf-8")
    return root


def test_each_format_has_its_runner(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(recorder_run.shutil, "which", lambda name: None)
    assert command_for("playwright-ts", tmp_path, "e2e/a.spec.ts")[:3] == [
        "npx",
        "playwright",
        "test",
    ]
    assert command_for("selenium-js", tmp_path, "t.cjs")[:2] == ["npx", "mocha"]
    assert command_for("cypress", tmp_path, "c.cy.js")[:3] == ["npx", "cypress", "run"]
    assert command_for("selenium-ruby", tmp_path, "s_spec.rb")[-1] == "s_spec.rb"
    assert command_for("selenium-csharp", tmp_path, "tests/E2E/ATests.cs")[1] == "test"
    (tmp_path / "pom.xml").write_text("<project/>", encoding="utf-8")
    assert (
        command_for("selenium-java", tmp_path, "src/ATest.java")[-1] == "-Dtest=ATest"
    )
    # pytest from the worktree's own environment when it has one.
    python = command_for("selenium-python", tmp_path, "t.py")
    assert python[1:4] == ["-m", "pytest", "t.py"]
    venv = tmp_path / ".venv" / "bin" / "python"
    venv.parent.mkdir(parents=True)
    venv.write_text("", encoding="utf-8")
    monkeypatch.setattr(recorder_run, "is_windows", lambda: False)
    assert command_for("playwright-python", tmp_path, "t.py")[0] == str(venv)
    with pytest.raises(ValueError, match="wdio.conf"):
        command_for("webdriverio", tmp_path, "test/specs/a.e2e.js")
    (tmp_path / "wdio.conf.ts").write_text("", encoding="utf-8")
    assert command_for("webdriverio-ts", tmp_path, "a.e2e.ts")[3:] == [
        "wdio.conf.ts",
        "--spec",
        "a.e2e.ts",
    ]


def test_the_python_on_the_path_without_a_virtual_environment(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(recorder_run.shutil, "which", lambda name: None)
    assert (
        command_for("selenium-python", tmp_path, "t.py")[0]
        == recorder_run.sys.executable
    )


def test_only_a_test_of_the_worktree_runs(tmp_path: Path) -> None:
    root = _worktree(tmp_path, "e2e/a.spec.ts")
    (tmp_path / "outside.spec.ts").write_text("x", encoding="utf-8")
    assert (
        locate_test(root, "e2e/a.spec.ts", "playwright-ts")
        == (root / "e2e/a.spec.ts").resolve()
    )
    for rel, fmt in (
        ("../outside.spec.ts", "playwright-ts"),
        ("e2e/gone.spec.ts", "playwright-ts"),
        ("e2e", "playwright-ts"),
        ("e2e/a.spec.ts", "selenium-ruby"),
    ):
        with pytest.raises(ValueError):
            locate_test(root, rel, fmt)


def _completed(code: int, out: str = "", err: str = ""):
    def run(command, **kwargs):
        assert kwargs["shell"] is False and kwargs["cwd"]
        return subprocess.CompletedProcess(command, code, out, err)

    return run


def test_a_run_reports_its_output_and_counts_first_runs(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    root = _worktree(tmp_path, "e2e/a.spec.ts")
    key = "sk-ant-api03-" + "a" * 40  # pragma: allowlist secret
    passed = run_recorded_test(
        project,
        root,
        "e2e/a.spec.ts",
        "playwright-ts",
        lambda: "ready",
        _completed(0, "1 passed", key),
    )
    assert passed.passed and passed.first and passed.setup == "ready"
    assert (passed.first_runs, passed.first_passed) == (1, 1)
    assert key not in passed.output and "1 passed" in passed.output
    again = run_recorded_test(
        project, root, "e2e/a.spec.ts", "playwright-ts", lambda: "ready", _completed(1)
    )
    # The same code ran before: not a first run, and the count holds.
    assert not again.passed and not again.first and again.first_passed == 1
    (root / "e2e/a.spec.ts").write_text("test(2)", encoding="utf-8")
    failed = run_recorded_test(
        project,
        root,
        "e2e/a.spec.ts",
        "playwright-ts",
        lambda: "partial",
        _completed(2),
    )
    assert failed.first and (failed.first_runs, failed.first_passed) == (2, 1)
    assert failed.to_dict()["exitCode"] == 2 and failed.to_dict()["firstRuns"] == 2


def test_a_runner_that_hangs_or_is_missing_fails_cleanly(tmp_path: Path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    root = _worktree(tmp_path, "t_spec.rb")

    def hang(command, **kwargs):
        raise subprocess.TimeoutExpired(command, 1)

    def missing(command, **kwargs):
        raise FileNotFoundError(command[0])

    slow = run_recorded_test(
        project, root, "t_spec.rb", "selenium-ruby", lambda: "ready", hang
    )
    assert slow.exit_code is None and "longer than" in slow.output
    (root / "t_spec.rb").write_text("other", encoding="utf-8")
    gone = run_recorded_test(
        project, root, "t_spec.rb", "selenium-ruby", lambda: "ready", missing
    )
    assert not gone.passed and "Install the test runner" in gone.output


def test_first_runs_are_bounded_and_survive_a_broken_file(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(recorder_run, "MAX_RUNS", 2)
    (tmp_path / RUNS_FILE).parent.mkdir(parents=True)
    (tmp_path / RUNS_FILE).write_text('{"runs": [1]}', encoding="utf-8")
    assert record_first_run(tmp_path, "a", True) == (True, 1, 1)
    record_first_run(tmp_path, "b", False)
    assert record_first_run(tmp_path, "c", True) == (True, 2, 1)
    runs = json.loads((tmp_path / RUNS_FILE).read_text(encoding="utf-8"))["runs"]
    assert list(runs) == ["b", "c"]
    (tmp_path / RUNS_FILE).write_text("[]", encoding="utf-8")
    assert record_first_run(tmp_path, "a", True)[0]


@pytest.fixture
def runner(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("recorder_runner_run_test", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _printed(capsys, prefix: str):
    [line] = [x for x in capsys.readouterr().out.splitlines() if x.startswith(prefix)]
    return json.loads(line[len(prefix) :])


def test_the_runner_prepares_the_worktree_then_runs(
    runner, tmp_path, monkeypatch, capsys
) -> None:
    from core.workspace import recipe_run

    project = tmp_path / "project"
    project.mkdir()
    root = _worktree(tmp_path, "e2e/a.spec.ts")
    prepared: list[tuple] = []

    class Report:
        status = "nothing-to-do"

    def prepare(*args):
        prepared.append(args)
        return Report()

    monkeypatch.setattr(recipe_run, "prepare_worktree", prepare)
    monkeypatch.setattr(recorder_run.subprocess, "run", _completed(0, "ok"))
    args = ["run", f"--project={project}", f"--root={root}", "--file=e2e/a.spec.ts"]
    assert runner.main([*args, "--format=playwright-ts", "--spec=007-x"]) == 0
    result = _printed(capsys, "RECORDER_RUN:")
    assert result["passed"] and result["setup"] == "nothing-to-do"
    assert prepared == [(project.resolve(), root.resolve(), "007-x")]
    gone = ["run", f"--project={project}", f"--root={tmp_path / 'gone'}", "--file=a"]
    assert runner.main([*gone, "--format=cypress", "--spec=s"]) == 1
    assert "Worktree not found" in _printed(capsys, "RECORDER_ERROR:")


def test_the_runner_reshoots_a_recording_headless(
    runner, tmp_path, monkeypatch, capsys
) -> None:
    from browser_agent import browser_controller
    from browser_agent.recorder_replay import ShotStep

    launched: list[bool] = []

    class Controller:
        def __init__(self, project_dir, headless):
            launched.append(headless)
            self.page = object()

        async def launch(self):
            return None

        async def close(self):
            launched.append(False)

    async def shoot(page, recording):
        return [ShotStep(step.id, "ok") for step in recording.steps]

    monkeypatch.setattr(browser_controller, "BrowserController", Controller)
    monkeypatch.setattr(recorder_replay_module(), "reshoot", shoot)
    steps = [
        {"id": "s1", "kind": "navigate", "url": "http://localhost:3000/"},
        {
            "id": "s2",
            "kind": "click",
            "selectors": [{"strategy": "css", "value": "#a"}],
        },
    ]
    monkeypatch.setattr(runner.sys, "stdin", _stdin(json.dumps({"steps": steps})))
    assert runner.main(["reshoot", f"--project={tmp_path}"]) == 0
    assert _printed(capsys, "RECORDER_RESHOOT:") == {
        "steps": [{"id": "s1", "status": "ok"}, {"id": "s2", "status": "ok"}]
    }
    assert launched == [True, False]
    monkeypatch.setattr(runner.sys, "stdin", _stdin(json.dumps({"steps": steps[1:]})))
    assert runner.main(["reshoot", f"--project={tmp_path}"]) == 1
    assert _printed(capsys, "RECORDER_ERROR:") == "The recording opens no page."
    monkeypatch.setattr(runner.sys, "stdin", _stdin('{"steps": []}'))
    assert runner.main(["reshoot", f"--project={tmp_path / 'gone'}"]) == 1


def recorder_replay_module():
    from browser_agent import recorder_replay

    return recorder_replay


def _stdin(text: str):
    import io

    return io.StringIO(text)
