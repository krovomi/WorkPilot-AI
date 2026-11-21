"""An incident's life in the orchestrator, from report to dashboard and disk.

Production reports keep the monitoring source that sent them, a rescan of the
code keeps one incident per fragile file, a finished operation cannot be
cancelled, and one incident this version cannot read does not take the others
with it.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from self_healing.incident_responder import mcp_connector
from self_healing.incident_responder.mcp_connector import MCPSourceConfig
from self_healing.incident_responder.models import (
    FragilityReport,
    HealingOperation,
    HealingStatus,
    Incident,
    IncidentMode,
    IncidentSeverity,
    IncidentSource,
    ProductionIncidentData,
)
from self_healing.incident_responder.orchestrator import (
    NEEDS_A_PERSON,
    IncidentResponderOrchestrator,
)
from self_healing.incident_responder.proactive_mode import ProactiveMode
from self_healing.incident_responder.production_mode import ProductionMode

VERIFY_STEP = "Verifying the app runs"


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """No hermes home, no brain, and an app verdict without launching anything."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "no-hermes"))
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "no-brain"))
    import verify.loop

    async def verdict(*_args, **_kwargs):
        return {"status": "pass"}

    monkeypatch.setattr(verify.loop, "run_verify_loop", verdict)


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


def _orch(project: Path, **kwargs) -> IncidentResponderOrchestrator:
    return IncidentResponderOrchestrator(project, **kwargs)


def _steps(operation) -> dict[str, tuple[str, str | None]]:
    return {s.name: (s.status, s.detail) for s in operation.steps}


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# --- production sources -----------------------------------------------


def test_a_polled_incident_keeps_the_source_that_reported_it(project, monkeypatch):
    async def reported(self):
        return [
            ProductionIncidentData(
                error_type="TimeoutError",
                error_message="upstream took too long",
                service_name="sentry-relay",
                occurrence_count=3,
            )
        ]

    async def broken(self):
        raise ConnectionError("source down")

    monkeypatch.setattr(mcp_connector.DatadogAdapter, "poll_incidents", reported)
    monkeypatch.setattr(mcp_connector.PagerDutyAdapter, "poll_incidents", broken)
    orch = _orch(project)
    for source in (IncidentSource.DATADOG, IncidentSource.PAGERDUTY):
        config = MCPSourceConfig(source=source, server_url="https://mcp.invalid")
        assert asyncio.run(orch.connect_production_source(config))

    opened = asyncio.run(orch.poll_production_incidents())

    # A service whose name holds another tool's name is still Datadog's report;
    # the source that failed does not stop the other.
    assert [i.source for i in opened] == [IncidentSource.DATADOG]
    assert opened[0].title == "TimeoutError: upstream took too long"
    assert orch.get_incidents(IncidentMode.PRODUCTION) == opened


def test_a_source_without_an_address_is_not_connected(project):
    orch = _orch(project)
    config = MCPSourceConfig(source=IncidentSource.SENTRY, api_key="k")

    assert not asyncio.run(orch.connect_production_source(config))
    assert not asyncio.run(orch.disconnect_production_source(IncidentSource.SENTRY))


def test_a_disconnected_source_leaves_the_status(project):
    orch = _orch(project)
    config = MCPSourceConfig(
        source=IncidentSource.SENTRY, server_url="https://mcp.invalid", api_key="k"
    )
    asyncio.run(orch.connect_production_source(config))
    status = orch.get_dashboard_data()["productionStatus"]
    assert status["connected_sources"] == ["sentry"]
    # The key is never shown.
    assert status["connector"]["configs"]["sentry"]["api_key"] == "***"

    assert asyncio.run(orch.disconnect_production_source(IncidentSource.SENTRY))

    assert orch.get_dashboard_data()["productionStatus"]["connected_sources"] == []


@pytest.mark.parametrize(
    "source",
    [
        IncidentSource.SENTRY,
        IncidentSource.DATADOG,
        IncidentSource.CLOUDWATCH,
        IncidentSource.NEW_RELIC,
        IncidentSource.PAGERDUTY,
    ],
)
def test_a_connected_source_without_a_reader_reports_nothing(project, source):
    orch = _orch(project)
    config = MCPSourceConfig(source=source, server_url="https://mcp.invalid")

    assert asyncio.run(orch.connect_production_source(config))

    assert asyncio.run(orch.poll_production_incidents()) == []
    assert orch.production.get_status()["connected_sources"] == [source.value]


def test_an_unknown_source_has_no_adapter(project):
    config = MCPSourceConfig(source=IncidentSource.GIT_PUSH, server_url="https://x")

    assert not asyncio.run(_orch(project).connect_production_source(config))


def test_a_production_incident_is_analysed_then_escalated(project):
    orch = _orch(project)

    operation = asyncio.run(
        orch.handle_production_incident(
            IncidentSource.SENTRY,
            {"error_type": "KeyError", "error_message": "'id'", "event_id": "e1"},
        )
    )

    assert operation.incident.status == HealingStatus.ESCALATED
    assert operation.incident.error_message == NEEDS_A_PERSON
    assert _steps(operation)["Analyzing incident"][0] == "completed"
    # No trace, so no location is claimed.
    assert "stack_locations" not in operation.incident.source_data


def test_a_trace_nobody_can_read_attaches_no_file(project, monkeypatch):
    import docintel.stacktrace

    def unreadable(*_args, **_kwargs):
        raise RuntimeError("reader broke")

    monkeypatch.setattr(docintel.stacktrace, "analyze", unreadable)

    incident = asyncio.run(
        ProductionMode(project).on_incident(
            IncidentSource.SENTRY,
            {"error_type": "E", "stack_trace": 'File "a.py", line 1, in f'},
        )
    )

    assert incident.affected_files == []
    assert "stack_locations" not in incident.source_data


def test_the_production_prompt_has_a_fallback(project, monkeypatch):
    mode = ProductionMode(project)
    incident = asyncio.run(
        mode.on_incident(IncidentSource.SENTRY, {"error_type": "ZeroDivisionError"})
    )

    def missing(self, *args, **kwargs):
        raise FileNotFoundError(self)

    monkeypatch.setattr(Path, "read_text", missing)

    prompt = mode.build_agent_prompt(incident)

    assert "## ERROR DETAILS" in prompt and "ZeroDivisionError" in prompt


# --- proactive scans --------------------------------------------------


def _fragile_project(project: Path) -> None:
    _write(
        project / "busy.py",
        "".join(f"def f{i}(a):\n    if a: pass\n" for i in range(30)),
    )
    _write(project / "calm.py", "x = 1\n")


def test_a_rescan_keeps_one_incident_per_fragile_file(project):
    _fragile_project(project)
    orch = _orch(project, risk_threshold=50)

    asyncio.run(orch.run_proactive_scan())
    first = orch.get_incidents(IncidentMode.PROACTIVE)
    _write(
        project / "busy.py",
        (project / "busy.py").read_text(encoding="utf-8") + "def g(): pass\n",
    )
    reports = asyncio.run(orch.run_proactive_scan())

    assert [r.file_path for r in orch.get_fragility_reports()] == ["busy.py"]
    assert [r.file_path for r in reports] == ["busy.py"]
    assert orch.get_incidents(IncidentMode.PROACTIVE) == first
    # The incident carries the measures of the last scan.
    assert first[0].source_data["cyclomatic_complexity"] == 61


def test_a_dismissed_fragile_file_is_reported_again_by_the_next_scan(project):
    _fragile_project(project)
    orch = _orch(project, risk_threshold=50)
    asyncio.run(orch.run_proactive_scan())
    first = orch.get_incidents(IncidentMode.PROACTIVE)[0]

    assert orch.dismiss_incident(first.id)
    asyncio.run(orch.run_proactive_scan())

    incidents = orch.get_incidents(IncidentMode.PROACTIVE)
    assert [i.status for i in incidents] == [
        HealingStatus.RESOLVED,
        HealingStatus.PENDING,
    ]


def test_proactive_incidents_scan_when_no_report_is_given(project):
    _fragile_project(project)
    mode = ProactiveMode(project, risk_threshold=0, churn_days=7)

    incidents = asyncio.run(mode.create_incidents_from_scan())

    assert [i.affected_files for i in incidents] == [["busy.py"], ["calm.py"]]
    assert "commits in 7 days" in incidents[0].description
    assert mode.last_reports[0].file_path == "busy.py"
    summary = mode.get_summary()
    assert summary["files_at_risk"] == 2 and summary["max_risk"] == 70.0


@pytest.mark.parametrize(
    ("score", "severity"),
    [
        (85, IncidentSeverity.HIGH),
        (80, IncidentSeverity.HIGH),
        (65, IncidentSeverity.MEDIUM),
        (45, IncidentSeverity.LOW),
    ],
)
def test_the_risk_score_sets_the_severity(project, score, severity):
    report = FragilityReport(file_path="a.py", risk_score=score)

    (incident,) = asyncio.run(
        ProactiveMode(project).create_incidents_from_scan([report])
    )

    assert incident.severity == severity


def test_the_proactive_prompt_has_a_fallback(project, monkeypatch):
    mode = ProactiveMode(project)
    (incident,) = asyncio.run(
        mode.create_incidents_from_scan([FragilityReport("src/a.py", 72.5)])
    )

    def missing(self, *args, **kwargs):
        raise FileNotFoundError(self)

    monkeypatch.setattr(Path, "read_text", missing)

    prompt = mode.build_agent_prompt(incident)

    assert "- Path: src/a.py" in prompt and "72.5/100" in prompt


# --- fixing, retrying, cancelling ---------------------------------------


def _pending(orch: IncidentResponderOrchestrator, **kwargs) -> Incident:
    incident = Incident(
        mode=IncidentMode.PROACTIVE,
        source=IncidentSource.PROACTIVE_SCAN,
        source_data={"file_path": "a.py", "risk_score": 50},
        **kwargs,
    )
    orch._incidents.append(incident)
    return incident


def test_a_fix_is_not_triggered_for_an_unknown_or_resolved_incident(project):
    orch = _orch(project)
    resolved = _pending(orch, status=HealingStatus.RESOLVED)

    assert asyncio.run(orch.trigger_fix("no-such-id")) is None
    assert asyncio.run(orch.trigger_fix(resolved.id)) is None
    assert asyncio.run(orch.retry_incident("no-such-id")) is None
    assert not orch.dismiss_incident("no-such-id")


def test_a_failed_incident_is_retried(project):
    orch = _orch(project)
    failed = _pending(orch, status=HealingStatus.FAILED)

    operation = asyncio.run(orch.retry_incident(failed.id))

    assert operation is not None
    assert failed.status == HealingStatus.ESCALATED
    assert orch.get_operations() == [operation]


def test_only_an_operation_in_progress_is_cancelled(project):
    orch = _orch(project)
    incident = _pending(orch)
    finished = asyncio.run(orch.trigger_fix(incident.id))
    running = orch._create_operation(_pending(orch))

    # The finished one keeps the verdict it reached.
    assert not orch.cancel_operation(finished.id)
    assert incident.status == HealingStatus.ESCALATED
    assert orch.cancel_operation(running.id)
    assert running.incident.status == HealingStatus.FAILED
    assert not orch.cancel_operation("no-such-id")


def test_an_operation_without_an_incident_is_cancelled(project):
    orch = _orch(project)
    orphan = HealingOperation()
    orch._operations.append(orphan)

    assert orch.cancel_operation(orphan.id)
    assert orphan.completed_at and not orphan.success


def test_a_step_completed_without_detail_keeps_its_own():
    operation = HealingOperation()
    step = operation.add_step("Reading", detail="started from the log")

    operation.complete_step(step, "completed")

    assert (step.status, step.detail) == ("completed", "started from the log")


def test_a_pipeline_that_breaks_fails_the_incident(project, monkeypatch):
    orch = _orch(project)
    incident = _pending(orch)

    def broken(_incident):
        raise RuntimeError("template unreadable")

    monkeypatch.setattr(orch.proactive, "build_agent_prompt", broken)

    operation = asyncio.run(orch.trigger_fix(incident.id))

    assert incident.status == HealingStatus.FAILED
    assert incident.error_message == "template unreadable"
    assert operation.completed_at and not operation.success


def test_the_average_resolution_time_counts_successful_operations(project):
    orch = _orch(project)
    for success, seconds in ((True, 4.0), (True, 8.0), (False, 100.0)):
        operation = orch._create_operation(_pending(orch))
        operation.finalize(success)
        operation.duration_seconds = seconds

    stats = orch.get_stats()

    assert stats.avg_resolution_time == 6.0
    assert stats.auto_fix_rate == round(2 / 3 * 100, 1)


# --- the runtime verification -------------------------------------------


def _verified(project: Path, monkeypatch, run) -> tuple[str, dict]:
    import verify.loop

    monkeypatch.setattr(verify.loop, "run_verify_loop", run)
    orch = _orch(project)
    operation = orch._create_operation(_pending(orch))
    verdict = asyncio.run(orch._verify_runtime(operation))
    return verdict, _steps(operation)


def test_a_verification_that_cannot_run_blocks_nothing(project, monkeypatch):
    async def broken(*_args, **_kwargs):
        raise OSError("no display")

    verdict, steps = _verified(project, monkeypatch, broken)

    assert verdict == "unknown"
    assert steps[VERIFY_STEP] == ("skipped", "could not verify: no display")


def test_an_inconclusive_verification_says_why(project, monkeypatch):
    async def inconclusive(*_args, **_kwargs):
        return {"status": "unverifiable", "reason": "no app to launch"}

    verdict, steps = _verified(project, monkeypatch, inconclusive)

    assert verdict == "unverifiable"
    assert steps[VERIFY_STEP] == ("skipped", "unverifiable — no app to launch")


def test_without_the_verification_loop_nothing_is_verified(project, monkeypatch):
    monkeypatch.setitem(sys.modules, "verify.loop", None)
    orch = _orch(project)
    operation = orch._create_operation(_pending(orch))

    assert asyncio.run(orch._verify_runtime(operation)) == "unknown"
    assert VERIFY_STEP not in _steps(operation)


def test_a_hermes_cycle_that_breaks_changes_nothing(project, monkeypatch):
    import hermes.loop

    def broken(*_args, **_kwargs):
        raise RuntimeError("hermes broke")

    monkeypatch.setattr(hermes.loop, "run_cycle", broken)
    orch = _orch(project)
    incident = _pending(orch)

    asyncio.run(orch.trigger_fix(incident.id))

    assert incident.status == HealingStatus.ESCALATED


# --- what is kept on disk -----------------------------------------------


def test_an_incident_this_version_cannot_read_does_not_drop_the_others(project):
    data_dir = project / ".workpilot" / "self-healing"
    good = Incident(title="kept").to_dict()
    unknown = {**Incident(title="from a later version").to_dict(), "status": "parked"}
    _write(data_dir / "incidents.json", json.dumps([good, unknown, "not an entry"]))

    orch = _orch(project)

    assert [i.title for i in orch.get_incidents()] == ["kept"]


@pytest.mark.parametrize("content", ["{not json", '{"not": "a list"}'])
def test_an_unreadable_state_starts_empty(project, content):
    data_dir = project / ".workpilot" / "self-healing"
    _write(data_dir / "incidents.json", content)
    _write(data_dir / "fragility_reports.json", "{not json")

    orch = _orch(project)

    assert orch.get_incidents() == [] and orch.get_fragility_reports() == []


def test_fragility_reports_are_kept_across_a_restart(project):
    _fragile_project(project)
    orch = _orch(project, risk_threshold=50)
    asyncio.run(orch.run_proactive_scan())

    again = _orch(project, risk_threshold=50)

    assert [r.to_dict() for r in again.get_fragility_reports()] == [
        r.to_dict() for r in orch.get_fragility_reports()
    ]


def test_a_state_that_cannot_be_written_is_not_a_crash(project, tmp_path):
    data_dir = tmp_path / "state"
    orch = _orch(project, data_dir=data_dir)
    data_dir.rmdir()
    data_dir.write_text("a file where the folder was", encoding="utf-8")

    assert orch.dismiss_incident(_pending(orch).id)
