"""The healing pipeline reports what it did, and nothing it did not (audit F48).

The pipeline used to mark "Generating fix", "Running QA validation" ("QA
validation passed") and "Creating pull request" ("PR created") `completed`
without running an agent, a QA loop or `gh`, name a branch nothing created,
then set `resolved_at` and finalize with `success=True`. The dashboard showed
the incident healed.

Until those steps are wired, they read `skipped` with their reason, the
incident ends `escalated` and the operation is not a success. What does run —
the analysis prompt, the runtime verification, the hermes cycle — still does.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from self_healing.incident_responder.models import (
    HealingStatus,
    Incident,
    IncidentMode,
    IncidentSource,
)
from self_healing.incident_responder.orchestrator import (
    FIX_NOT_RUN,
    NEEDS_A_PERSON,
    PR_NOT_RUN,
    QA_NOT_RUN,
    IncidentResponderOrchestrator,
)

FIX_STEP = "Generating fix in isolated worktree"
QA_STEP = "Running QA validation"
PR_STEP = "Creating pull request"
VERIFY_STEP = "Verifying the app runs"

#: The only steps whose work the pipeline performs today.
STEPS_THAT_RUN = {"Analyzing incident", VERIFY_STEP, "Filing what hermes learned"}


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    """No hermes home, no brain: the cycle finds nothing and files nothing."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "no-hermes"))
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "no-brain"))


@pytest.fixture
def app_verdict(monkeypatch):
    """The verification loop's verdict, without launching anything."""
    import verify.loop

    verdict = {"status": "pass", "score": 92}

    async def fake_run_verify_loop(*_args, **_kwargs):
        return dict(verdict)

    monkeypatch.setattr(verify.loop, "run_verify_loop", fake_run_verify_loop)
    return verdict


def _orchestrator(
    project: Path, monkeypatch, **kwargs
) -> IncidentResponderOrchestrator:
    orch = IncidentResponderOrchestrator(project, **kwargs)
    monkeypatch.setattr(orch.cicd, "_get_commit_diff", lambda sha: "diff of " + sha)
    return orch


def _steps(operation) -> dict[str, tuple[str, str | None]]:
    return {s.name: (s.status, s.detail) for s in operation.steps}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


class TestNothingIsClaimed:
    async def test_a_cicd_failure_is_escalated_not_healed(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)

        operation = await orch.handle_cicd_failure(
            commit_sha="abc1234def",
            branch="main",
            test_output="FAILED tests/test_x.py::test_y - AssertionError",
        )

        steps = _steps(operation)
        assert steps[FIX_STEP] == ("skipped", FIX_NOT_RUN)
        assert steps[QA_STEP] == ("skipped", QA_NOT_RUN)
        assert steps[PR_STEP] == ("skipped", PR_NOT_RUN)
        assert steps[VERIFY_STEP][0] == "completed"

        incident = operation.incident
        assert operation.success is False
        assert operation.completed_at is not None
        assert incident.status == HealingStatus.ESCALATED
        assert incident.resolved_at is None
        assert incident.fix_branch is None
        assert incident.fix_pr_url is None
        assert incident.error_message == NEEDS_A_PERSON

    @pytest.mark.parametrize("mode", list(IncidentMode))
    async def test_no_mode_reports_work_it_did_not_do(
        self, project, monkeypatch, app_verdict, mode
    ):
        orch = _orchestrator(project, monkeypatch)
        incident = Incident(
            mode=mode,
            source=IncidentSource.SENTRY,
            title=f"{mode.value} incident",
            source_data={"error_type": "TypeError", "file_path": "app.py"},
        )
        orch._incidents.append(incident)

        operation = await orch.trigger_fix(incident.id)

        completed = {s.name for s in operation.steps if s.status == "completed"}
        assert completed <= STEPS_THAT_RUN
        details = " ".join(s.detail or "" for s in operation.steps)
        assert "QA validation passed" not in details
        assert "PR created" not in details
        assert "Fix branch" not in details
        assert operation.success is False
        assert incident.status == HealingStatus.ESCALATED

    async def test_no_pr_step_when_pr_creation_is_off(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch, auto_create_pr=False)

        operation = await orch.handle_cicd_failure(
            commit_sha="abc1234def", branch="main", test_output="1 failed"
        )

        assert PR_STEP not in _steps(operation)
        assert operation.incident.status == HealingStatus.ESCALATED

    async def test_an_app_that_does_not_start_fails_the_incident(
        self, project, monkeypatch, app_verdict
    ):
        app_verdict.update(status="fail", reason="exit code 1 at startup")
        orch = _orchestrator(project, monkeypatch)

        operation = await orch.handle_cicd_failure(
            commit_sha="abc1234def", branch="main", test_output="1 failed"
        )

        steps = _steps(operation)
        assert steps[VERIFY_STEP] == ("failed", "exit code 1 at startup")
        assert steps[FIX_STEP][0] == "skipped"
        assert operation.success is False
        assert operation.incident.status == HealingStatus.FAILED

    async def test_the_dashboard_counts_no_fix(self, project, monkeypatch, app_verdict):
        orch = _orchestrator(project, monkeypatch)
        await orch.handle_cicd_failure(
            commit_sha="abc1234def", branch="main", test_output="1 failed"
        )

        stats = orch.get_stats()
        assert stats.resolved_incidents == 0
        assert stats.auto_fix_rate == 0.0

        stored = json.loads(
            (project / ".workpilot" / "self-healing" / "incidents.json").read_text(
                encoding="utf-8"
            )
        )
        assert [i["status"] for i in stored] == ["escalated"]
        assert stored[0]["resolved_at"] is None
        assert stored[0]["fix_branch"] is None


class TestPreserved:
    async def test_hermes_still_observes_an_escalated_incident(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)
        observed = []
        monkeypatch.setattr(orch, "_observe_with_hermes", observed.append)

        operation = await orch.handle_cicd_failure(
            commit_sha="abc1234def", branch="main", test_output="1 failed"
        )

        assert observed == [operation]

    async def test_the_analysis_still_builds_the_prompt(
        self, project, monkeypatch, app_verdict
    ):
        orch = _orchestrator(project, monkeypatch)

        operation = await orch.handle_cicd_failure(
            commit_sha="abc1234def", branch="main", test_output="1 failed"
        )

        status, detail = _steps(operation)["Analyzing incident"]
        assert status == "completed"
        assert detail.startswith("Prompt built (")


class TestIncidentsStoredBeforeTheFix:
    """The placeholder's "healed" incidents are on users' disks already."""

    def _store(self, project: Path, incidents: list[Incident]) -> None:
        data_dir = project / ".workpilot" / "self-healing"
        data_dir.mkdir(parents=True)
        (data_dir / "incidents.json").write_text(
            json.dumps([i.to_dict() for i in incidents]), encoding="utf-8"
        )

    def _claimed(self, status: HealingStatus) -> Incident:
        incident = Incident(title="claimed", status=status, resolved_at="2026-10-01")
        incident.fix_branch = f"self-healing/{incident.id}"
        return incident

    @pytest.mark.parametrize(
        "status", [HealingStatus.PR_CREATED, HealingStatus.QA_RUNNING]
    )
    def test_a_claimed_heal_is_reopened(self, project, status):
        claimed = self._claimed(status)
        self._store(project, [claimed])

        (incident,) = IncidentResponderOrchestrator(project).get_incidents()

        assert incident.status == HealingStatus.ESCALATED
        assert incident.resolved_at is None
        assert incident.fix_branch is None
        assert incident.error_message == NEEDS_A_PERSON

    @pytest.mark.parametrize("status", [HealingStatus.RESOLVED, HealingStatus.FAILED])
    def test_a_person_s_or_a_failure_s_verdict_stays(self, project, status):
        self._store(project, [self._claimed(status)])

        (incident,) = IncidentResponderOrchestrator(project).get_incidents()

        assert incident.status == status
        assert incident.fix_branch is None

    def test_a_real_pr_is_left_alone(self, project):
        incident = self._claimed(HealingStatus.PR_CREATED)
        incident.fix_pr_url = "https://example.invalid/pr/1"
        self._store(project, [incident])

        (loaded,) = IncidentResponderOrchestrator(project).get_incidents()

        assert loaded.status == HealingStatus.PR_CREATED
        assert loaded.fix_branch == incident.fix_branch
