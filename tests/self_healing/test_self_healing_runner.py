"""runners/self_healing_runner.py: the CLI behind the Self-Healing view.

The commands that read and write the project's `.workpilot/self-healing/`
files run as the desktop app runs them, `python runners/self_healing_runner.py`
with no PYTHONPATH, and the files are checked on disk afterwards. The commands
that heal (CI/CD, production, proactive, fix, retry) go through the real
argument parsing and dispatch, with a stand-in orchestrator in place of the
one that calls a model.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
RUNNER = BACKEND / "runners" / "self_healing_runner.py"
DATA = Path(".workpilot") / "self-healing"


def _run(
    project: Path, *argv: str, stdin: str | None = None
) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
    return subprocess.run(
        [sys.executable, str(RUNNER), "--project", str(project), *argv],
        cwd=BACKEND,
        env=env,
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
    )


@pytest.fixture
def project(tmp_path):
    project = tmp_path / "project"
    (project / DATA).mkdir(parents=True)
    return project


def _write(project: Path, name: str, data) -> Path:
    path = project / DATA / name
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


# ── As the desktop app starts it ────────────────────────────────────────


def test_without_a_command_prints_the_commands(project):
    done = _run(project)
    assert done.returncode == 0
    assert "disconnect" in done.stdout


def test_config_merges_each_mode_into_one_file(project):
    assert (
        _run(
            project, "config", "--mode", "cicd", "--data", '{"autoFixEnabled": false}'
        ).returncode
        == 0
    )
    done = _run(
        project, "config", "--mode", "cicd", "--data", '{"autoCreatePR": false}'
    )
    assert done.returncode == 0
    assert json.loads(done.stdout)["config"] == {
        "autoFixEnabled": False,
        "autoCreatePR": False,
    }
    saved = json.loads((project / DATA / "config.json").read_text(encoding="utf-8"))
    assert saved == {"cicd": {"autoFixEnabled": False, "autoCreatePR": False}}

    bad = _run(project, "config", "--mode", "proactive", "--data", "{nope")
    assert bad.returncode == 1
    assert "Invalid JSON" in json.loads(bad.stdout)["error"]


def test_incidents_and_operations_read_what_is_on_disk(project):
    assert json.loads(_run(project, "incidents").stdout) == []
    assert json.loads(_run(project, "operations").stdout) == []

    _write(
        project,
        "incidents.json",
        [{"id": "i1", "mode": "cicd"}, {"id": "i2", "mode": "production"}],
    )
    _write(project, "operations.json", [{"id": "o1"}])
    assert [
        i["id"]
        for i in json.loads(_run(project, "incidents", "--mode", "production").stdout)
    ] == ["i2"]
    assert len(json.loads(_run(project, "incidents").stdout)) == 2
    assert json.loads(_run(project, "operations").stdout) == [{"id": "o1"}]


def test_unreadable_files_are_reported_not_raised(project):
    (project / DATA / "incidents.json").write_text("{broken", encoding="utf-8")
    (project / DATA / "operations.json").write_text("{broken", encoding="utf-8")
    for command in ("incidents", "operations", "cancel"):
        argv = [command] + (["--operation-id", "o1"] if command == "cancel" else [])
        done = _run(project, *argv)
        assert done.returncode == 1
        assert "error" in json.loads(done.stdout)


def test_cancel_closes_the_operation_and_fails_its_incident(project):
    assert json.loads(_run(project, "cancel", "--operation-id", "o1").stdout) == {
        "success": False,
        "error": "No operations found",
    }
    _write(
        project,
        "operations.json",
        [{"id": "o1", "success": None, "incident": {"id": "i1"}}],
    )
    _write(
        project,
        "incidents.json",
        [{"id": "i0", "status": "analyzing"}, {"id": "i1", "status": "fixing"}],
    )
    assert (
        "not found"
        in json.loads(_run(project, "cancel", "--operation-id", "o9").stdout)["error"]
    )

    done = _run(project, "cancel", "--operation-id", "o1")
    assert done.returncode == 0
    operation = json.loads(
        (project / DATA / "operations.json").read_text(encoding="utf-8")
    )[0]
    assert operation["success"] is False
    assert operation["completed_at"]
    incidents = json.loads(
        (project / DATA / "incidents.json").read_text(encoding="utf-8")
    )
    assert [i["status"] for i in incidents] == ["analyzing", "failed"]


def test_cancel_keeps_going_when_the_incident_file_is_broken(project):
    _write(project, "operations.json", [{"id": "o1", "incident": {"id": "i1"}}])
    (project / DATA / "incidents.json").write_text("{broken", encoding="utf-8")
    done = _run(project, "cancel", "--operation-id", "o1")
    assert json.loads(done.stdout) == {"success": True, "operation_id": "o1"}


def test_an_unknown_source_is_refused_before_any_connection(project):
    for argv in (
        ["connect", "--source", "splunk", "--config", "{}"],
        ["disconnect", "--source", "splunk"],
    ):
        done = _run(project, *argv)
        assert done.returncode == 1
        assert "Unknown source 'splunk'" in json.loads(done.stdout)["error"]
    bad = _run(project, "connect", "--source", "sentry", "--config", "{nope")
    assert "Invalid JSON" in json.loads(bad.stdout)["error"]


def test_dashboard_and_dismiss_on_a_project_without_incidents(project):
    done = _run(project, "dashboard", "--json")
    assert done.returncode == 0
    assert json.loads(done.stdout)["stats"]["totalIncidents"] == 0

    text = _run(project, "dashboard")
    assert "Self-Healing Dashboard" in text.stdout
    assert "Total incidents:    0" in text.stdout

    dismissed = _run(project, "dismiss", "--incident-id", "nope")
    assert dismissed.returncode == 1
    assert json.loads(dismissed.stdout) == {"success": False, "incident_id": "nope"}

    fixed = _run(project, "fix", "--incident-id", "nope")
    assert json.loads(fixed.stdout) == {
        "step": "failed",
        "error": "Incident nope not found",
    }


def test_a_broken_config_falls_back_to_the_defaults(project):
    (project / DATA / "config.json").write_text("{broken", encoding="utf-8")
    done = _run(project, "dashboard", "--json")
    assert done.returncode == 0
    # Saving a mode starts the file again rather than failing on it.
    assert (
        _run(project, "config", "--mode", "production", "--data", '{"a": 1}').returncode
        == 0
    )
    assert json.loads((project / DATA / "config.json").read_text(encoding="utf-8")) == {
        "production": {"a": 1}
    }


# ── The healing commands, with a stand-in orchestrator ──────────────────


@pytest.fixture(scope="module")
def runner():
    saved = list(sys.path)
    spec = importlib.util.spec_from_file_location("self_healing_runner_cli", RUNNER)
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path[:] = saved
    return module


class Operation(SimpleNamespace):
    def to_dict(self):
        return {"id": self.id, "success": self.success}


def _operation(success: bool, error: str = "", pr: str | None = None) -> Operation:
    incident = SimpleNamespace(
        fix_branch="heal/fix-1", fix_pr_url=pr, error_message=error, title="Boom"
    )
    return Operation(id="op-1", success=success, incident=incident)


class Report(SimpleNamespace):
    def to_dict(self):
        return {"file_path": self.file_path, "risk_score": self.risk_score}


class Orchestrator:
    """Answers each call with what the test put in `answers`, and records it."""

    def __init__(self):
        self.answers: dict = {}
        self.calls: list = []
        self.cicd = SimpleNamespace(run_tests=self._call("run_tests"))
        self.proactive = SimpleNamespace(get_summary=lambda: self.answers["summary"])

    def _call(self, name):
        async def call(*args, **kwargs):
            self.calls.append((name, args, kwargs))
            return self.answers[name]

        return call

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        answer = self.__dict__["answers"].get(name)
        if callable(answer):
            return answer
        return self._call(name)


@pytest.fixture
def stand_in(runner, monkeypatch):
    orchestrator = Orchestrator()
    monkeypatch.setattr(
        runner.SelfHealingRunner, "_get_orchestrator", lambda self: orchestrator
    )
    return orchestrator


def _main(runner, monkeypatch, project: Path, *argv: str) -> int:
    monkeypatch.setattr(
        sys, "argv", ["self_healing_runner.py", "--project", str(project), *argv]
    )
    with pytest.raises(SystemExit) as stop:
        runner.main()
    return stop.value.code


def test_cicd_heals_the_failure_it_is_given(
    runner, stand_in, monkeypatch, project, capsys
):
    stand_in.answers["handle_cicd_failure"] = _operation(True, pr="https://pr/1")
    code = _main(
        runner,
        monkeypatch,
        project,
        "cicd",
        "--commit",
        "abc",
        "--test-output",
        "FAILED t",
        "--ci-log-url",
        "u",
    )
    assert code == 0
    assert stand_in.calls == [
        (
            "handle_cicd_failure",
            (),
            {
                "commit_sha": "abc",
                "branch": "main",
                "test_output": "FAILED t",
                "ci_log_url": "u",
            },
        )
    ]
    out = capsys.readouterr().out
    assert "Fix applied in branch: heal/fix-1" in out
    assert "PR: https://pr/1" in out


def test_cicd_runs_the_tests_itself_when_given_no_output(
    runner, stand_in, monkeypatch, project, capsys
):
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(isatty=lambda: True))
    stand_in.answers["run_tests"] = (True, "", [])
    assert _main(runner, monkeypatch, project, "cicd", "--commit", "abc") == 0
    assert "All tests passing. No healing needed." in capsys.readouterr().out

    stand_in.answers["run_tests"] = (False, "FAILED a\nFAILED b", ["a", "b"])
    stand_in.answers["handle_cicd_failure"] = _operation(
        False, error="No safe fix found"
    )
    assert _main(runner, monkeypatch, project, "cicd", "--commit", "abc") == 1
    out = capsys.readouterr().out
    assert "2 test(s) failing. Starting healing pipeline..." in out
    assert "No fix applied. The incident needs manual review." in out
    assert "   No safe fix found" in out
    assert stand_in.calls[-1][2]["test_output"] == "FAILED a\nFAILED b"


def test_cicd_reads_the_failure_from_stdin(runner, stand_in, monkeypatch, project):
    class Piped:
        def isatty(self):
            return False

        def read(self):
            return "FAILED from a pipe"

    monkeypatch.setattr(sys, "stdin", Piped())
    stand_in.answers["handle_cicd_failure"] = _operation(True)
    assert _main(runner, monkeypatch, project, "cicd", "--commit", "abc") == 0
    assert stand_in.calls[0][2]["test_output"] == "FAILED from a pipe"


def test_cicd_refuses_a_capture_it_cannot_use(
    runner, stand_in, monkeypatch, project, capsys
):
    import self_healing.incident_responder.cicd_mode as cicd_mode

    monkeypatch.setattr(
        cicd_mode.CICDMode,
        "read_capture",
        lambda self, path: ("", "nothing could be read (empty)"),
    )
    assert (
        _main(
            runner,
            monkeypatch,
            project,
            "cicd",
            "--commit",
            "abc",
            "--capture",
            "shot.png",
        )
        == 1
    )
    assert "Capture not used: nothing could be read (empty)" in capsys.readouterr().out
    assert stand_in.calls == []

    monkeypatch.setattr(
        cicd_mode.CICDMode, "read_capture", lambda self, path: ("FAILED in shot", "")
    )
    stand_in.answers["handle_cicd_failure"] = _operation(True)
    assert (
        _main(
            runner,
            monkeypatch,
            project,
            "cicd",
            "--commit",
            "abc",
            "--capture",
            "shot.png",
        )
        == 0
    )
    assert stand_in.calls[0][2]["test_output"] == "FAILED in shot"


def test_production_hands_the_error_over(
    runner, stand_in, monkeypatch, project, capsys
):
    stand_in.answers["handle_production_incident"] = _operation(True)
    argv = [
        "production",
        "--source",
        "sentry",
        "--error-type",
        "TypeError",
        "--error-message",
        "x is None",
    ]
    assert _main(runner, monkeypatch, project, *argv, "--occurrences", "4") == 0
    _name, _args, kwargs = stand_in.calls[0]
    assert kwargs["source"].value == "sentry"
    assert kwargs["error_data"] == {
        "error_type": "TypeError",
        "error_message": "x is None",
        "stack_trace": "",
        "occurrence_count": 4,
    }
    assert "Incident resolved! Fix in branch: heal/fix-1" in capsys.readouterr().out

    stand_in.answers["handle_production_incident"] = _operation(False)
    assert _main(runner, monkeypatch, project, *argv) == 1
    assert "No fix applied." in capsys.readouterr().out

    assert (
        _main(
            runner,
            monkeypatch,
            project,
            "production",
            "--source",
            "syslog",
            "--error-type",
            "E",
            "--error-message",
            "m",
        )
        == 1
    )
    assert "Unknown source: syslog" in capsys.readouterr().out


def test_proactive_lists_the_riskiest_files(
    runner, stand_in, monkeypatch, project, capsys
):
    long_path = "src/" + "deep/" * 14 + "module.py"
    stand_in.answers["run_proactive_scan"] = [
        Report(
            file_path=long_path,
            risk_score=72.5,
            cyclomatic_complexity=31,
            git_churn_count=12,
            test_coverage_percent=4.0,
        ),
        Report(
            file_path="b.py",
            risk_score=41.0,
            cyclomatic_complexity=8,
            git_churn_count=3,
            test_coverage_percent=50.0,
        ),
    ]
    stand_in.answers["summary"] = {"avg_risk": 56.7, "max_risk": 72.5}
    assert _main(runner, monkeypatch, project, "proactive", "--top-n", "1") == 1
    out = capsys.readouterr().out
    assert "Found 2 file(s) above risk threshold" in out
    assert "..." + long_path[-55:] in out
    assert "b.py" not in out
    assert "Maximum risk score: 72.5" in out

    stand_in.answers["summary"] = {"avg_risk": 10, "max_risk": 30}
    assert _main(runner, monkeypatch, project, "proactive") == 0
    capsys.readouterr()
    assert _main(runner, monkeypatch, project, "proactive", "--json") == 0
    assert json.loads(capsys.readouterr().out)[1] == {
        "file_path": "b.py",
        "risk_score": 41.0,
    }

    stand_in.answers["run_proactive_scan"] = []
    assert _main(runner, monkeypatch, project, "proactive") == 0
    assert "No fragile code zones detected." in capsys.readouterr().out


def test_dashboard_text_lists_incidents_and_fragile_files(
    runner, stand_in, monkeypatch, project, capsys
):
    stand_in.answers["get_dashboard_data"] = lambda: {
        "stats": {
            "totalIncidents": 2,
            "resolvedIncidents": 1,
            "activeIncidents": 1,
            "avgResolutionTime": 30,
            "autoFixRate": 50,
        },
        "incidents": [
            {"status": "resolved", "mode": "cicd", "title": "Red build"},
            {"status": "something_new", "mode": "production", "title": "500s"},
        ],
        "fragilityReports": [{"file_path": "a.py", "risk_score": 80}],
    }
    assert _main(runner, monkeypatch, project, "dashboard") == 0
    out = capsys.readouterr().out
    assert "Recent incidents (2):" in out
    assert "✅ [cicd] Red build" in out
    assert "❓ [production] 500s" in out
    assert "a.py — risk 80/100" in out


def test_dashboard_json_that_cannot_be_written_is_a_failure(
    runner, stand_in, monkeypatch, project, capsys
):
    stand_in.answers["get_dashboard_data"] = lambda: {"stats": float("nan")}
    monkeypatch.setattr(
        runner.json,
        "dumps",
        lambda *a, **k: (_ for _ in ()).throw(ValueError("Out of range")),
    )
    assert _main(runner, monkeypatch, project, "dashboard", "--json") == 1
    assert "Error serializing dashboard data: Out of range" in capsys.readouterr().out


@pytest.mark.parametrize(
    "command, first_step, method",
    [("fix", "analyzing", "trigger_fix"), ("retry", "retrying", "retry_incident")],
)
def test_fix_and_retry_stream_their_steps(
    runner, stand_in, monkeypatch, project, capsys, command, first_step, method
):
    stand_in.answers["_find_incident"] = lambda incident_id: None
    assert _main(runner, monkeypatch, project, command, "--incident-id", "i1") == 1
    assert json.loads(capsys.readouterr().out)["error"] == "Incident i1 not found"

    stand_in.answers["_find_incident"] = lambda incident_id: SimpleNamespace(
        title="Boom"
    )
    stand_in.answers[method] = None
    assert _main(runner, monkeypatch, project, command, "--incident-id", "i1") == 1
    first, last = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert first == {"step": first_step, "incident_id": "i1", "title": "Boom"}
    assert last["step"] == "failed"

    stand_in.answers[method] = _operation(True)
    assert _main(runner, monkeypatch, project, command, "--incident-id", "i1") == 0
    last = json.loads(capsys.readouterr().out.splitlines()[-1])
    assert last == {
        "step": "complete",
        "success": True,
        "operation": {"id": "op-1", "success": True},
    }


def test_connect_and_disconnect_reach_the_orchestrator(
    runner, stand_in, monkeypatch, project, capsys
):
    stand_in.answers["connect_production_source"] = True
    config = '{"server_url": "https://sentry.example", "project_id": "p1"}'
    assert (
        _main(
            runner,
            monkeypatch,
            project,
            "connect",
            "--source",
            "sentry",
            "--config",
            config,
        )
        == 0
    )
    source_config = stand_in.calls[0][1][0]
    assert (
        source_config.server_url,
        source_config.project_id,
        source_config.environment,
    ) == (
        "https://sentry.example",
        "p1",
        "production",
    )
    stand_in.answers["disconnect_production_source"] = False
    assert _main(runner, monkeypatch, project, "disconnect", "--source", "sentry") == 1
    assert json.loads(capsys.readouterr().out.splitlines()[-1]) == {
        "success": False,
        "source": "sentry",
    }


def test_the_orchestrator_follows_the_saved_config(runner, project):
    _write(
        project,
        "config.json",
        {
            "cicd": {"autoFixEnabled": False, "autoCreatePR": False},
            "proactive": {"riskThreshold": 65},
        },
    )
    orchestrator = runner.SelfHealingRunner(project)._get_orchestrator()
    assert (
        orchestrator.auto_fix,
        orchestrator.auto_create_pr,
        orchestrator.proactive.risk_threshold,
    ) == (False, False, 65.0)


def test_an_unknown_command_prints_the_help(runner, capsys):
    parser = SimpleNamespace(print_help=lambda: print("usage: help"))
    assert runner._dispatch(None, SimpleNamespace(command="later"), parser) is False
    assert "usage: help" in capsys.readouterr().out
