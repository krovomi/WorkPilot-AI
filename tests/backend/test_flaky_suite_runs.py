"""The flaky detective runs the project's tests itself (``suite_runs``).

Before this, the detective only read reports already on the disk, and a
project that did not keep them (most, a .NET solution first: ``dotnet test``
writes no report unless asked) always showed "0 flaky out of 0 tests".
"""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from foundation.platform import is_windows  # noqa: E402
from runners import flaky_tests_runner as ftr  # noqa: E402
from suite_runner import runs as tr  # noqa: E402

TRX = """<?xml version="1.0" encoding="UTF-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>
  <UnitTestResult testName="Ns.T.Ok" outcome="Passed" duration="00:00:00.01"/>
  <UnitTestResult testName="Ns.T.Flaky" outcome="{outcome}" duration="00:00:00.01">
    <Output><ErrorInfo><Message>Timeout after 5s</Message></ErrorInfo></Output>
  </UnitTestResult>
</Results></TestRun>
"""


def _write(path: Path, text: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def _ids(project: Path) -> list[str]:
    return [c.id for c in tr.detect_test_commands(project)]


# --- detection --------------------------------------------------------


def test_dotnet_targets_the_shallowest_solution(tmp_path: Path) -> None:
    _write(tmp_path / "samples" / "Demo" / "Demo.sln")
    _write(tmp_path / "src" / "App.sln")
    _write(tmp_path / "Root.slnx")
    (command,) = tr.detect_test_commands(tmp_path)
    assert command.id == "dotnet"
    assert command.command == "dotnet test Root.slnx"


def test_dotnet_without_solution_prefers_a_test_project(tmp_path: Path) -> None:
    _write(tmp_path / "src" / "App" / "App.csproj", "<Project/>")
    _write(tmp_path / "tests" / "App.Tests" / "App.Tests.csproj", "<Project/>")
    _write(tmp_path / "src" / "App" / "bin" / "Ignored.Tests.csproj", "<Project/>")
    (command,) = tr.detect_test_commands(tmp_path)
    assert command.command == "dotnet test tests/App.Tests/App.Tests.csproj"


def test_js_commands_need_their_runner(tmp_path: Path) -> None:
    _write(
        tmp_path / "package.json",
        json.dumps({"devDependencies": {"vitest": "^3", "jest": "^29"}}),
    )
    # jest without jest-junit writes no report: not offered.
    assert _ids(tmp_path) == ["vitest"]
    _write(
        tmp_path / "package.json",
        json.dumps({"devDependencies": {"jest": "^29", "jest-junit": "^16"}}),
    )
    assert _ids(tmp_path) == ["jest"]


def test_pytest_uses_the_project_virtualenv(tmp_path: Path) -> None:
    _write(tmp_path / "pyproject.toml", "[tool.pytest.ini_options]\n")
    _write(tmp_path / ".venv" / "bin" / "python")
    (command,) = tr.detect_test_commands(tmp_path)
    assert command.id == "pytest"
    assert command.command == ".venv/bin/python -m pytest"


def test_jvm_and_go_commands(tmp_path: Path) -> None:
    _write(tmp_path / "pom.xml", "<project/>")
    _write(tmp_path / "mvnw")
    _write(tmp_path / "build.gradle")
    _write(tmp_path / "go.mod", "module x")
    commands = {c.id: c.command for c in tr.detect_test_commands(tmp_path)}
    assert commands == {
        "maven": "./mvnw test",
        "gradle": "gradle cleanTest test --continue",
        "go": "go test ./...",
    }


def test_nothing_detected_on_a_plain_folder(tmp_path: Path) -> None:
    _write(tmp_path / "README.md", "hello")
    assert tr.detect_test_commands(tmp_path) == []


# --- invocation -------------------------------------------------------


def test_dotnet_writes_trx_into_the_run_folder(tmp_path: Path) -> None:
    command = tr.TestCommand("dotnet", "C# / .NET", "dotnet test App.sln")
    out = tmp_path / "out"
    first = tr._invocation(command, tmp_path, out, no_build=False)
    assert first.argv[-4:] == [
        "--logger",
        "trx;LogFilePrefix=flaky",
        "--results-directory",
        str(out),
    ]
    again = tr._invocation(command, tmp_path, out, no_build=True)
    assert again.argv[-1] == "--no-build"


def test_report_flags_per_runner(tmp_path: Path) -> None:
    out = tmp_path / "out"

    def argv(cid: str, cmd: str) -> list[str]:
        return tr._invocation(
            tr.TestCommand(cid, cid, cmd), tmp_path, out, no_build=False
        ).argv

    assert f"--junitxml={out / 'junit.xml'}" in argv("pytest", "python3 -m pytest")
    assert f"--outputFile.junit={out / 'junit.xml'}" in argv("vitest", "npx vitest run")
    assert argv("go", "go test ./...")[1:4] == ["test", "-json", "-count=1"]
    jest = tr._invocation(
        tr.TestCommand("jest", "Jest", "npx jest --ci"), tmp_path, out, no_build=False
    )
    assert jest.env["JEST_JUNIT_OUTPUT_DIR"] == str(out)
    maven = tr._invocation(
        tr.TestCommand("maven", "Maven", "mvn test"), tmp_path, out, no_build=False
    )
    assert maven.collect_changed


def test_go_json_becomes_junit(tmp_path: Path) -> None:
    events = [
        {"Action": "run", "Package": "p", "Test": "TestA"},
        {
            "Action": "output",
            "Package": "p",
            "Test": "TestA",
            "Output": "x_test.go:3: timeout\n",
        },
        {"Action": "fail", "Package": "p", "Test": "TestA", "Elapsed": 0.2},
        {"Action": "pass", "Package": "p", "Test": "TestB", "Elapsed": 0.1},
        {"Action": "skip", "Package": "p", "Test": "TestC"},
        {"Action": "pass", "Package": "p"},
    ]
    lines = [json.dumps(e) for e in events] + ["not json"]
    report = tr.go_json_to_junit(lines, tmp_path / "junit.xml")
    assert report is not None
    runs = {r.test_name: r for r in ftr._parse_report_file(report, "r")}
    assert set(runs) == {"p::TestA", "p::TestB"}  # skipped excluded
    assert runs["p::TestA"].passed is False
    assert "timeout" in runs["p::TestA"].error_message
    assert tr.go_json_to_junit(["{}"], tmp_path / "none.xml") is None


# --- one run ----------------------------------------------------------


class _FakeProcess:
    def __init__(self, pid: int = 4242) -> None:
        self.pid = pid

    def wait(self, timeout: float | None = None) -> int:
        return 1

    def poll(self) -> int:
        return 1


def test_run_once_collects_the_reports_and_strips_credentials(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-secret")
    seen: dict = {}

    def popen(argv, **kwargs):
        seen.update(kwargs, argv=argv)
        out = Path(argv[argv.index("--results-directory") + 1])
        _write(out / "flaky_net8.0.trx", TRX.format(outcome="Failed"))
        return _FakeProcess()

    command = tr.TestCommand("dotnet", "C# / .NET", "dotnet test App.sln")
    outcome = tr.run_once(
        command, tmp_path, tmp_path / "run-01", timeout_s=60, popen=popen
    )
    assert outcome.exit_code == 1
    assert [p.name for p in outcome.reports] == ["flaky_net8.0.trx"]
    assert "ANTHROPIC_API_KEY" not in seen["env"]
    assert seen["env"]["CI"] == "1"
    assert seen["cwd"] == str(tmp_path)
    assert "shell" not in seen


def test_run_once_copies_reports_the_run_changed(tmp_path: Path) -> None:
    old = _write(
        tmp_path / "target" / "surefire-reports" / "TEST-Old.xml", "<testsuite/>"
    )
    stamp = old.stat().st_mtime

    def popen(argv, **kwargs):
        _write(
            tmp_path / "target" / "surefire-reports" / "TEST-New.xml", "<testsuite/>"
        )
        return _FakeProcess()

    command = tr.TestCommand("maven", "Maven", "mvn test")
    outcome = tr.run_once(
        command,
        tmp_path,
        tmp_path / ".workpilot" / "run",
        timeout_s=60,
        report_globs=ftr.REPORT_GLOBS,
        popen=popen,
    )
    assert old.stat().st_mtime == stamp
    assert [p.name.split("-", 1)[1] for p in outcome.reports] == ["TEST-New.xml"]


def test_run_once_reports_a_command_that_cannot_start(tmp_path: Path) -> None:
    def popen(argv, **kwargs):
        raise FileNotFoundError("dotnet")

    command = tr.TestCommand("dotnet", "C# / .NET", "dotnet test App.sln")
    outcome = tr.run_once(
        command, tmp_path, tmp_path / "run", timeout_s=60, popen=popen
    )
    assert outcome.exit_code is None
    assert "could not start" in outcome.error


@pytest.mark.skipif(is_windows(), reason="the Windows leg kills with taskkill /T")
def test_timeout_kills_the_whole_tree(tmp_path: Path) -> None:
    import psutil

    script = _write(
        tmp_path / "hang.py",
        "import subprocess, sys, time\n"
        "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "time.sleep(60)\n",
    )
    command = tr.TestCommand("maven", "custom", f"{sys.executable} {script}")
    started = time.monotonic()
    children: list[int] = []
    real_popen = subprocess.Popen

    def popen(argv, **kwargs):
        process = real_popen(argv, **kwargs)
        time.sleep(1)
        children.extend(c.pid for c in psutil.Process(process.pid).children())
        return process

    outcome = tr.run_once(command, tmp_path, tmp_path / "run", timeout_s=2, popen=popen)
    assert outcome.timed_out
    assert time.monotonic() - started < 30
    assert children
    time.sleep(0.5)
    for pid in children:
        assert (
            not psutil.pid_exists(pid)
            or psutil.Process(pid).status() == psutil.STATUS_ZOMBIE
        )


# --- the runner's run mode --------------------------------------------


def _fake_runs(
    monkeypatch: pytest.MonkeyPatch, outcomes: list[str | None]
) -> list[bool]:
    """Each call writes a TRX with the next outcome (None: no report)."""
    flags: list[bool] = []
    queue = list(outcomes)

    def run_once(
        command,
        project,
        out_dir,
        *,
        timeout_s,
        no_build=False,
        report_globs=(),
        only=(),
    ):
        flags.append(no_build)
        outcome = queue.pop(0)
        out_dir.mkdir(parents=True, exist_ok=True)
        reports = []
        if outcome:
            reports.append(_write(out_dir / "r.trx", TRX.format(outcome=outcome)))
        return tr.RunOutcome(1, reports=reports, output_tail="error CS1002: ; expected")

    monkeypatch.setattr(ftr, "run_once", run_once)
    monkeypatch.setattr(ftr, "install_cancel_handler", lambda: None)
    return flags


def test_run_mode_finds_the_flaky_test(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    _write(tmp_path / "App.sln")
    no_build = _fake_runs(monkeypatch, ["Passed", "Failed", "Passed", "Failed"])
    result = ftr.run_repeated(
        tmp_path, runs=4, command_id="auto", threshold=0.05, min_runs=2, timeout_s=60
    )
    assert result["mode"] == "run"
    assert result["runCount"] == 4
    assert result["command"] == "dotnet test App.sln"
    assert result["summaryCode"] == "flaky"
    assert [t["testName"] for t in result["flakyTests"]] == ["Ns.T.Flaky"]
    assert result["flakyTests"][0]["probableCause"] == "timing"
    # The first run builds, the next ones reuse that build.
    assert no_build == [False, True, True, True]
    events = [
        json.loads(line.split(":", 1)[1])
        for line in capsys.readouterr().out.splitlines()
        if line.startswith("FLAKY_EVENT:")
    ]
    finished = [e["data"] for e in events if e["data"].get("code") == "run_finished"]
    assert [(d["run"], d["passed"], d["failed"]) for d in finished] == [
        (1, 2, 0),
        (2, 1, 1),
        (3, 2, 0),
        (4, 1, 1),
    ]


def test_run_mode_lists_tests_failing_every_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "App.sln")
    _fake_runs(monkeypatch, ["Failed", "Failed", "Failed"])
    result = ftr.run_repeated(
        tmp_path, runs=3, command_id="dotnet", threshold=0.05, min_runs=2, timeout_s=60
    )
    assert result["flakyCount"] == 0
    assert result["summaryCode"] == "no_flaky"
    assert result["alwaysFailing"] == ["Ns.T.Flaky"]


def test_run_mode_stops_when_the_first_run_writes_no_report(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _write(tmp_path / "App.sln")
    no_build = _fake_runs(monkeypatch, [None, "Passed", "Passed"])
    with pytest.raises(ftr.RunError) as error:
        ftr.run_repeated(
            tmp_path,
            runs=3,
            command_id="auto",
            threshold=0.05,
            min_runs=2,
            timeout_s=60,
        )
    assert str(error.value).startswith("no_results:")
    assert "CS1002" in str(error.value)  # the build error is shown
    assert no_build == [False]  # not run twice for nothing


def test_run_mode_needs_a_detected_command(tmp_path: Path) -> None:
    with pytest.raises(ftr.RunError, match="^no_command:"):
        ftr._pick_command(tmp_path, "auto")
    _write(tmp_path / "go.mod", "module x")
    with pytest.raises(ftr.RunError, match="^no_command:"):
        ftr._pick_command(tmp_path, "dotnet")
    assert ftr._pick_command(tmp_path, "go").id == "go"


def test_scan_reads_the_kept_runs(tmp_path: Path) -> None:
    runs = tmp_path / tr.HISTORY_DIR / "20261102-120000"
    for index, outcome in enumerate(["Passed", "Failed", "Passed"], start=1):
        _write(runs / f"run-{index:02d}" / "flaky.trx", TRX.format(outcome=outcome))
    result = ftr.run_scan(tmp_path, threshold=0.05, min_runs=2)
    assert result["mode"] == "scan"
    assert result["reportCount"] == 3
    assert result["flakyCount"] == 1


def test_scan_without_reports_offers_the_detected_command(tmp_path: Path) -> None:
    _write(tmp_path / "App.sln")
    result = ftr.run_scan(tmp_path, threshold=0.05, min_runs=2)
    assert result["summaryCode"] == "no_reports"
    assert result["detectedCommands"] == [
        {"id": "dotnet", "label": "C# / .NET", "command": "dotnet test App.sln"}
    ]


def test_detect_mode_prints_the_commands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    _write(tmp_path / "go.mod", "module x")
    monkeypatch.setattr(
        sys, "argv", ["runner", "--project-path", str(tmp_path), "--mode", "detect"]
    )
    ftr.main()
    out = capsys.readouterr().out.strip()
    assert out.startswith("FLAKY_RESULT:")
    assert json.loads(out.split(":", 1)[1]) == {
        "detectedCommands": [{"id": "go", "label": "Go", "command": "go test ./..."}]
    }


def test_runner_error_is_one_json_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture
) -> None:
    monkeypatch.setattr(
        sys, "argv", ["runner", "--project-path", str(tmp_path), "--mode", "run"]
    )
    with pytest.raises(SystemExit):
        ftr.main()
    (line,) = capsys.readouterr().out.strip().splitlines()
    assert json.loads(line.split(":", 1)[1]).startswith("no_command:")
