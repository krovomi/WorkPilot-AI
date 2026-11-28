"""The generational tests runner: one run of the project's own suite, captured
or compared, with the command of the stack and never one from the caller."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from runners import generational_tests_runner as gtr  # noqa: E402
from suite_runner.runs import RunOutcome, TestCommand  # noqa: E402

TRX = """<?xml version="1.0" encoding="utf-8"?>
<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><Results>
  <UnitTestResult testName="Shop.Tests.CartTests.Adds" outcome="{adds}" duration="00:00:00.01"/>
  <UnitTestResult testName="Shop.Tests.CartTests.Removes" outcome="Passed" duration="00:00:00.01"/>
</Results></TestRun>"""

DOTNET = TestCommand("dotnet", "C# / .NET", "dotnet test Shop.sln")


@pytest.fixture
def suite(monkeypatch: pytest.MonkeyPatch):
    """A .NET project whose next run writes the TRX in ``state['adds']``."""
    state = {"adds": "Passed", "calls": [], "exit": 0, "write": True}
    monkeypatch.setattr(gtr, "detect_test_commands", lambda _p: [DOTNET])

    def fake_run_once(command, project, out_dir, **kwargs):
        state["calls"].append((command.id, out_dir, kwargs))
        out_dir.mkdir(parents=True, exist_ok=True)
        reports = []
        if state["write"]:
            report = out_dir / "flaky.trx"
            report.write_text(TRX.format(adds=state["adds"]), encoding="utf-8")
            reports.append(report)
        return RunOutcome(state["exit"], reports=reports, output_tail="Build FAILED")

    monkeypatch.setattr(gtr, "run_once", fake_run_once)
    return state


def _result(capsys: pytest.CaptureFixture[str]) -> tuple[str, object]:
    line = capsys.readouterr().out.strip().splitlines()[-1]
    prefix, _, payload = line.partition(":")
    return prefix, json.loads(payload)


def test_capture_then_compare_a_dotnet_run(
    tmp_path: Path, suite, capsys: pytest.CaptureFixture[str]
) -> None:
    assert (
        gtr.main(
            ["--project-path", str(tmp_path), "--mode", "capture", "--label", "v1"]
        )
        == 0
    )
    prefix, result = _result(capsys)
    assert prefix == "GEN_RESULT"
    assert result == {
        "label": "v1",
        "command": "dotnet test Shop.sln",
        "outcome_count": 2,
        "passing_count": 2,
    }
    run_dir = suite["calls"][0][1]
    assert run_dir.parent == tmp_path / gtr.RUNS_DIR

    suite["adds"] = "Failed"
    assert (
        gtr.main(
            ["--project-path", str(tmp_path), "--mode", "compare", "--baseline", "v1"]
        )
        == 0
    )
    _, compared = _result(capsys)
    assert compared["report"]["summary"]["regressed"] == 1
    assert compared["report"]["items"][0]["test_id"] == "Shop.Tests.CartTests::Adds"


def test_a_run_without_a_report_says_why(
    tmp_path: Path, suite, capsys: pytest.CaptureFixture[str]
) -> None:
    suite["write"] = False
    suite["exit"] = 1
    assert (
        gtr.main(
            ["--project-path", str(tmp_path), "--mode", "capture", "--label", "v1"]
        )
        == 1
    )
    prefix, error = _result(capsys)
    assert prefix == "GEN_ERROR"
    assert error.startswith("no_results: dotnet test Shop.sln (exit code 1)")
    assert "Build FAILED" in error


def test_a_bad_label_is_refused_before_the_suite_runs(
    tmp_path: Path, suite, capsys: pytest.CaptureFixture[str]
) -> None:
    assert (
        gtr.main(
            ["--project-path", str(tmp_path), "--mode", "capture", "--label", "../x"]
        )
        == 1
    )
    prefix, error = _result(capsys)
    assert prefix == "GEN_ERROR"
    assert error.startswith("invalid:")
    assert suite["calls"] == []


def test_compare_needs_an_existing_baseline(
    tmp_path: Path, suite, capsys: pytest.CaptureFixture[str]
) -> None:
    assert (
        gtr.main(
            ["--project-path", str(tmp_path), "--mode", "compare", "--baseline", "nope"]
        )
        == 1
    )
    _, error = _result(capsys)
    assert error == "no_baseline: nope"
    assert suite["calls"] == []


def test_only_a_detected_command_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gtr, "detect_test_commands", lambda _p: [DOTNET])
    assert gtr.pick_command(tmp_path, "auto") is DOTNET
    with pytest.raises(gtr.RunError, match="^no_command"):
        gtr.pick_command(tmp_path, "cargo")
    with pytest.raises(SystemExit):
        gtr.main(
            [
                "--project-path",
                str(tmp_path),
                "--mode",
                "capture",
                "--command-id",
                "rm -rf /",
            ]
        )


def test_a_dotnet_solution_without_test_project(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(gtr, "detect_test_commands", lambda _p: [])
    (tmp_path / "Shop.csproj").write_text(
        "<Project Sdk='Microsoft.NET.Sdk'/>", encoding="utf-8"
    )
    with pytest.raises(gtr.RunError, match="^no_dotnet_tests"):
        gtr.pick_command(tmp_path, "auto")


def test_old_runs_are_pruned(tmp_path: Path) -> None:
    root = tmp_path / "runs"
    for index in range(gtr.KEEP_RUNS + 3):
        (root / f"20261114-1000{index:02d}").mkdir(parents=True)
    gtr._prune(root)
    kept = sorted(p.name for p in root.iterdir())
    assert len(kept) == gtr.KEEP_RUNS
    assert kept[-1] == f"20261114-1000{gtr.KEEP_RUNS + 2:02d}"


def test_detect_lists_the_commands(
    tmp_path: Path, suite, capsys: pytest.CaptureFixture[str]
) -> None:
    assert gtr.main(["--project-path", str(tmp_path), "--mode", "detect"]) == 0
    _, result = _result(capsys)
    assert result == {"commands": [DOTNET.to_dict()]}


def test_a_missing_folder(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert gtr.main(["--project-path", str(tmp_path / "gone"), "--mode", "detect"]) == 1
    prefix, _ = _result(capsys)
    assert prefix == "GEN_ERROR"
