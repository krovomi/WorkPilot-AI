"""The Agent Coach runner, run as the Personal Coach panel runs it.

Real run records and a real usage ledger in a project folder; the coach
engine and the ledger ingest are the real ones.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "agent_coach_runner.py"
RESULT = "AGENT_COACH_RESULT:"
ERROR = "AGENT_COACH_ERROR:"
EVENT = "AGENT_COACH_EVENT:"


def _process(project: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(RUNNER), "--project-path", str(project)],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=False,
    )


def _lines(out: str, prefix: str) -> list[str]:
    return [line[len(prefix) :] for line in out.splitlines() if line.startswith(prefix)]


def _write(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = payload if isinstance(payload, str) else json.dumps(payload)
    path.write_text(text, encoding="utf-8")


def test_a_missing_project_is_refused(tmp_path: Path) -> None:
    done = _process(tmp_path / "gone")

    assert done.returncode == 1
    [error] = _lines(done.stdout, ERROR)
    assert error.startswith("Project path does not exist")


def test_an_empty_project_is_a_report_with_no_runs(tmp_path: Path) -> None:
    done = _process(tmp_path)

    assert done.returncode == 0, done.stderr
    [result] = _lines(done.stdout, RESULT)
    assert json.loads(result)["report"]["totalRuns"] == 0
    events = [json.loads(e)["type"] for e in _lines(done.stdout, EVENT)]
    assert events == ["start", "progress", "complete"]


def test_run_records_and_the_usage_ledger_are_coached_together(
    tmp_path: Path,
) -> None:
    runs = tmp_path / ".workpilot" / "agent-runs"
    _write(
        runs / "a.json",
        [
            {
                "agentName": "coder",
                "runId": "r1",
                "success": False,
                "durationS": 300,
                "tokensUsed": 120_000,
                "costUsd": 2.5,
                "errors": ["timeout"],
                "retries": 3,
                "model": "model-a",
            },
            {
                "agent_name": "coder",
                "run_id": "r2",
                "success": False,
                "model": "model-a",
            },
            {"agentName": "qa_reviewer", "tokensUsed": "lots"},  # unreadable: skipped
            {"runId": "no-agent"},  # no agent name: skipped
            "not a record",
        ],
    )
    _write(runs / "b.json", {"agentName": "planner", "costUsd": 0.1})
    _write(runs / "broken.json", "{not json")
    _write(runs / "scalar.json", 42)
    (runs / "folder.json").mkdir()
    _write(
        tmp_path / ".workpilot" / "cost_data.json",
        {
            "usages": [
                {
                    "spec_id": "001-cart",
                    "agent_type": "planner",
                    "model": "model-b",
                    "input_tokens": 1000,
                    "output_tokens": 500,
                    "cost": 0.02,
                }
            ]
        },
    )

    done = _process(tmp_path)

    assert done.returncode == 0, done.stderr
    report = json.loads(_lines(done.stdout, RESULT)[0])["report"]
    # coder x2, planner from its record, planner from the ledger.
    assert report["totalRuns"] == 4
    assert report["successRate"] == 0.5
    assert report["mostFailingAgent"] == "coder"
    assert report["tips"], report
    tip = report["tips"][0]
    assert set(tip) == {
        "category",
        "priority",
        "title",
        "description",
        "evidence",
        "action",
    }
    progress = [json.loads(e)["data"] for e in _lines(done.stdout, EVENT)]
    assert progress[1]["status"] == "Loaded 4 run record(s), generating report..."
    assert progress[2] == {"totalRuns": 4, "tips": len(report["tips"])}


@pytest.fixture
def runner(monkeypatch):
    monkeypatch.syspath_prepend(str(BACKEND))
    spec = importlib.util.spec_from_file_location("agent_coach_runner_t", RUNNER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _main(runner, monkeypatch, project: Path) -> int | None:
    monkeypatch.setattr(
        sys, "argv", ["agent_coach_runner.py", "--project-path", str(project)]
    )
    try:
        runner.main()
    except SystemExit as stop:
        return stop.code
    return None


def test_a_ledger_that_cannot_be_read_still_reports_the_records(
    runner, monkeypatch, tmp_path, capsys
) -> None:
    import agent_coach.usage_ingest

    def unreadable(_project):
        raise PermissionError("cost_data.json is locked")

    monkeypatch.setattr(
        agent_coach.usage_ingest, "load_agent_runs_from_usage", unreadable
    )
    _write(tmp_path / ".workpilot" / "agent-runs" / "a.json", {"agentName": "coder"})

    assert _main(runner, monkeypatch, tmp_path) is None

    out = capsys.readouterr().out
    statuses = [json.loads(e)["data"].get("status") for e in _lines(out, EVENT)]
    assert "Usage ledger ingest skipped: cost_data.json is locked" in statuses
    assert json.loads(_lines(out, RESULT)[0])["report"]["totalRuns"] == 1


def test_a_failing_report_ends_with_the_error_line(
    runner, monkeypatch, tmp_path, capsys
) -> None:
    def broken(self):
        raise RuntimeError("engine broke")

    monkeypatch.setattr(runner.CoachEngine, "generate_report", broken)

    assert _main(runner, monkeypatch, tmp_path) == 1
    assert _lines(capsys.readouterr().out, ERROR) == ["engine broke"]
