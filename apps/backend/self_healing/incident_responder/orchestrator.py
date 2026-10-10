"""
Incident Responder Orchestrator
=================================

Unified coordinator for all three self-healing modes:
- CI/CD Mode: Test regression detection and auto-fix
- Production Mode: APM incident response
- Proactive Mode: Fragility analysis and preventive testing

Manages the healing lifecycle: detection -> analysis -> fix -> QA -> PR.
Only detection, analysis and the runtime verification run today: fix, QA and
PR are reported `skipped` and the incident is escalated to a person (F48).
Persists incidents and operations to JSON for dashboard display.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from .cicd_mode import CICDMode
from .mcp_connector import MCPSourceConfig
from .models import (
    FragilityReport,
    HealingOperation,
    HealingStatus,
    Incident,
    IncidentMode,
    IncidentSource,
    SelfHealingStats,
    _now_iso,
)
from .proactive_mode import ProactiveMode
from .production_mode import ProductionMode

logger = logging.getLogger(__name__)

# The steps the pipeline names but does not run yet (F48). They used to read
# `completed` — "QA validation passed", "PR created" — with no agent, no QA and
# no PR behind them, and the incident came out healed. Until a fixer session
# (`core.client.create_agent_client` in a worktree), the QA loop and the
# worktree manager's PR creation are wired here, each is reported `skipped`
# with its reason, and the incident goes to a person: a step that did nothing
# never reads `completed`.
FIX_NOT_RUN = "not run: no fixer session is wired to the healing pipeline yet"
QA_NOT_RUN = "not run: there is no fix to validate"
PR_NOT_RUN = "not run: there is no fix to propose"
NEEDS_A_PERSON = (
    "No fix was generated: the healing pipeline analyses an incident but does "
    "not run a fixer yet, so a person has to take it from here."
)

# The statuses the placeholder pipeline left behind on an incident it claimed
# to have healed: `pr_created`, or `qa_running` when PR creation was off.
_CLAIMED_HEALED = (HealingStatus.PR_CREATED, HealingStatus.QA_RUNNING)


def _reopen_claimed_heal(incident: Incident) -> None:
    """Undo what the placeholder pipeline claimed on an incident stored before F48.

    It named a branch, ``self-healing/<id>``, that nothing ever created, and
    marked the incident healed. Nothing has ever set ``fix_pr_url``, so that
    branch name without a PR is its signature. The branch name goes; a claimed
    heal becomes an escalation. An incident a person dismissed stays resolved,
    and one that failed stays failed: those verdicts were not the placeholder's.
    """
    if incident.fix_pr_url or incident.fix_branch != f"self-healing/{incident.id}":
        return
    incident.fix_branch = None
    if incident.status in _CLAIMED_HEALED:
        incident.status = HealingStatus.ESCALATED
        incident.resolved_at = None
        incident.error_message = NEEDS_A_PERSON


class IncidentResponderOrchestrator:
    """Unified orchestrator for the Self-Healing Codebase + Incident Responder system.

    Coordinates all three modes and manages the healing lifecycle from
    incident detection to escalation; fix, QA and PR are not wired yet (F48).
    """

    def __init__(
        self,
        project_dir: str | Path,
        data_dir: str | Path | None = None,
        risk_threshold: float = 40.0,
        max_files: int = 100,
        auto_fix: bool = True,
        auto_create_pr: bool = True,
    ):
        self.project_dir = Path(project_dir)
        self.data_dir = (
            Path(data_dir)
            if data_dir
            else self.project_dir / ".workpilot" / "self-healing"
        )
        self.auto_fix = auto_fix
        self.auto_create_pr = auto_create_pr

        # Initialize modes
        self.cicd = CICDMode(project_dir)
        self.production = ProductionMode(project_dir)
        self.proactive = ProactiveMode(
            project_dir,
            risk_threshold=risk_threshold,
            max_files=max_files,
        )

        # State
        self._incidents: list[Incident] = []
        self._operations: list[HealingOperation] = []
        self._fragility_reports: list[FragilityReport] = []

        # Ensure data directory exists
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # Load persisted state
        self._load_state()

    # ── CI/CD Mode ──────────────────────────────────────────────

    async def handle_cicd_failure(
        self,
        commit_sha: str,
        branch: str,
        test_output: str,
        failing_tests: list[str] | None = None,
        ci_log_url: str | None = None,
        pipeline_id: str | None = None,
    ) -> HealingOperation:
        """Handle a CI/CD test failure end-to-end.

        Creates an incident, starts a healing operation, and if auto_fix
        is enabled, proceeds through the full healing pipeline.
        """
        incident = await self.cicd.on_test_failure(
            commit_sha=commit_sha,
            branch=branch,
            test_output=test_output,
            failing_tests=failing_tests,
            ci_log_url=ci_log_url,
            pipeline_id=pipeline_id,
        )

        self._incidents.append(incident)
        operation = self._create_operation(incident)

        if self.auto_fix:
            await self._run_healing_pipeline(operation, incident)

        self._save_state()
        return operation

    # ── Production Mode ─────────────────────────────────────────

    async def handle_production_incident(
        self,
        source: IncidentSource,
        error_data: dict[str, Any],
    ) -> HealingOperation:
        """Handle a production incident end-to-end."""
        incident = await self.production.on_incident(source, error_data)

        self._incidents.append(incident)
        operation = self._create_operation(incident)

        if self.auto_fix:
            await self._run_healing_pipeline(operation, incident)

        self._save_state()
        return operation

    async def connect_production_source(self, config: MCPSourceConfig) -> bool:
        """Connect to a production monitoring source."""
        return await self.production.connect_source(config)

    async def disconnect_production_source(self, source: IncidentSource) -> bool:
        """Disconnect from a production monitoring source."""
        return await self.production.disconnect_source(source)

    async def poll_production_incidents(self) -> list[Incident]:
        """Poll all connected production sources for new incidents."""
        incidents = await self.production.poll_incidents()
        self._incidents.extend(incidents)
        self._save_state()
        return incidents

    # ── Proactive Mode ──────────────────────────────────────────

    async def run_proactive_scan(self) -> list[FragilityReport]:
        """Run a proactive fragility scan.

        Returns fragility reports and creates incidents for the most risky files.
        """
        reports = await self.proactive.scan_fragility()
        self._fragility_reports = reports

        # Create incidents for top risky files
        incidents = await self.proactive.create_incidents_from_scan(reports)
        self._incidents.extend(incidents)

        self._save_state()
        return reports

    # ── Common Operations ───────────────────────────────────────

    async def trigger_fix(self, incident_id: str) -> HealingOperation | None:
        """Manually trigger a fix for a specific incident."""
        incident = self._find_incident(incident_id)
        if not incident:
            logger.warning(f"Incident not found: {incident_id}")
            return None

        if incident.status in (HealingStatus.RESOLVED, HealingStatus.PR_CREATED):
            logger.info(f"Incident already resolved: {incident_id}")
            return None

        operation = self._create_operation(incident)
        await self._run_healing_pipeline(operation, incident)
        self._save_state()
        return operation

    async def retry_incident(self, incident_id: str) -> HealingOperation | None:
        """Retry healing for a failed incident."""
        incident = self._find_incident(incident_id)
        if not incident:
            return None

        incident.status = HealingStatus.PENDING
        return await self.trigger_fix(incident_id)

    def dismiss_incident(self, incident_id: str) -> bool:
        """Dismiss an incident (mark as resolved without fixing)."""
        incident = self._find_incident(incident_id)
        if not incident:
            return False

        incident.status = HealingStatus.RESOLVED
        incident.resolved_at = _now_iso()
        self._save_state()
        return True

    def cancel_operation(self, operation_id: str) -> bool:
        """Cancel an in-progress healing operation."""
        for op in self._operations:
            if op.id == operation_id:
                op.finalize(success=False)
                if op.incident:
                    op.incident.status = HealingStatus.FAILED
                self._save_state()
                return True
        return False

    # ── Dashboard Data ──────────────────────────────────────────

    def get_dashboard_data(self) -> dict[str, Any]:
        """Get all data needed for the dashboard."""
        return {
            "incidents": [i.to_dict() for i in self._incidents],
            "activeOperations": [
                o.to_dict() for o in self._operations if not o.completed_at
            ],
            "fragilityReports": [r.to_dict() for r in self._fragility_reports],
            "stats": self.get_stats().to_dict(),
            "productionStatus": self.production.get_status(),
            "proactiveSummary": self.proactive.get_summary(),
        }

    def get_incidents(self, mode: IncidentMode | None = None) -> list[Incident]:
        """Get incidents, optionally filtered by mode."""
        if mode:
            return [i for i in self._incidents if i.mode == mode]
        return self._incidents

    def get_operations(self) -> list[HealingOperation]:
        """Get all healing operations."""
        return self._operations

    def get_fragility_reports(self) -> list[FragilityReport]:
        """Get the latest fragility reports."""
        return self._fragility_reports

    def get_stats(self) -> SelfHealingStats:
        """Compute aggregate statistics."""
        total = len(self._incidents)
        resolved = sum(
            1
            for i in self._incidents
            if i.status in (HealingStatus.RESOLVED, HealingStatus.PR_CREATED)
        )
        active = sum(
            1
            for i in self._incidents
            if i.status
            not in (
                HealingStatus.RESOLVED,
                HealingStatus.PR_CREATED,
                HealingStatus.FAILED,
                HealingStatus.ESCALATED,
            )
        )

        # Average resolution time
        resolution_times: list[float] = []
        for op in self._operations:
            if op.success and op.duration_seconds:
                resolution_times.append(op.duration_seconds)
        avg_time = (
            sum(resolution_times) / len(resolution_times) if resolution_times else 0.0
        )

        # Auto-fix rate
        auto_fixed = sum(1 for op in self._operations if op.success)
        fix_rate = auto_fixed / total * 100 if total > 0 else 0.0

        return SelfHealingStats(
            total_incidents=total,
            resolved_incidents=resolved,
            active_incidents=active,
            avg_resolution_time=round(avg_time, 1),
            auto_fix_rate=round(fix_rate, 1),
        )

    # ── Internal ────────────────────────────────────────────────

    async def _run_healing_pipeline(
        self, operation: HealingOperation, incident: Incident
    ) -> None:
        """Run the healing pipeline for an incident.

        Steps: analyze -> fix -> QA -> verify -> PR

        Analysis builds the mode-specific prompt and the runtime verification
        launches the app; fix, QA and PR are not wired, so they are reported
        `skipped` and the incident ends `escalated`, never resolved (F48).
        """
        try:
            # Step 1: Analyze
            step = operation.add_step("Analyzing incident")
            incident.status = HealingStatus.ANALYZING

            # Build mode-specific agent prompt
            if incident.mode == IncidentMode.CICD:
                prompt = self.cicd.build_agent_prompt(incident)
            elif incident.mode == IncidentMode.PRODUCTION:
                prompt = self.production.build_agent_prompt(incident)
            elif incident.mode == IncidentMode.PROACTIVE:
                prompt = self.proactive.build_agent_prompt(incident)
            else:
                operation.complete_step(step, "failed", "Unknown incident mode")
                operation.finalize(success=False)
                incident.status = HealingStatus.FAILED
                return

            operation.complete_step(
                step, "completed", f"Prompt built ({len(prompt)} chars)"
            )

            # Steps 2 and 3: fix and QA. Nothing runs the prompt yet, so
            # there is no branch to name and no result to validate.
            self._skip_step(
                operation, "Generating fix in isolated worktree", FIX_NOT_RUN
            )
            self._skip_step(operation, "Running QA validation", QA_NOT_RUN)

            # Step 3b: the app, launched — the verification loop's
            # deterministic half (no fixer, no driving session). With no fix
            # applied it checks the checkout as it stands: an app that no
            # longer starts is the first thing the person taking the incident
            # needs to know.
            verdict = await self._verify_runtime(operation)
            if verdict == "fail":
                incident.status = HealingStatus.FAILED
                incident.error_message = "the app failed its runtime verification"
                operation.finalize(success=False)
                return

            # Step 4: PR. Shown only when the user asked for one, so the
            # timeline says why there is none.
            if self.auto_create_pr:
                self._skip_step(operation, "Creating pull request", PR_NOT_RUN)

            # Nothing was fixed, so nothing is resolved.
            incident.status = HealingStatus.ESCALATED
            incident.error_message = NEEDS_A_PERSON
            operation.finalize(success=False)
            logger.info(
                f"Incident {incident.id} analysed; no fixer is wired, escalated"
            )

        except Exception as e:
            logger.error(f"Healing pipeline failed for incident {incident.id}: {e}")
            incident.status = HealingStatus.FAILED
            incident.error_message = str(e)
            operation.finalize(success=False)
        finally:
            # An incident cycle has ended, whichever way it ended. That is the
            # same kind of moment the build pipeline's `observe` phase marks,
            # so the hermes learning cycle turns here too — under its own
            # surface, so a reviewer reading `skills/_proposed/` can tell an
            # incident's candidate from a build's.
            #
            # In `finally` rather than on the success path: a pipeline that
            # failed is not a reason to skip it. What hermes authored, it
            # authored on Telegram or a cron job somewhere WorkPilot was not
            # watching, and this incident's outcome says nothing about it.
            self._observe_with_hermes(operation)

    @staticmethod
    def _skip_step(operation: HealingOperation, name: str, reason: str) -> None:
        """Record a step the pipeline names but did not run, with why."""
        step = operation.add_step(name)
        operation.complete_step(step, "skipped", reason)

    async def _verify_runtime(self, operation: HealingOperation) -> str:
        """Launch the project's app and read the verdict (`verify.loop`).

        Returns the record's status. Never raises: a verification that cannot
        run is ``unknown`` and blocks nothing; only a measured failure does.
        """
        try:
            from verify.loop import LoopOptions, run_verify_loop
        except ImportError as exc:
            logger.debug("verification unavailable: %s", exc)
            return "unknown"
        step = operation.add_step("Verifying the app runs")
        try:
            record = await run_verify_loop(
                self.project_dir,
                None,
                None,
                LoopOptions(effort="low", drive=False, mobile_build=False),
            )
        except Exception as exc:  # noqa: BLE001 - a verification reports
            operation.complete_step(step, "skipped", f"could not verify: {exc}")
            return "unknown"
        status = str(record.get("status") or "unknown")
        reason = str(record.get("reason") or "")
        score = record.get("score")
        if status == "pass":
            detail = "app launched clean" + (
                f", score {score}/100" if score is not None else ""
            )
            operation.complete_step(step, "completed", detail)
        elif status == "fail":
            operation.complete_step(
                step, "failed", reason or "the app failed its verification"
            )
        else:
            operation.complete_step(
                step, "skipped", f"{status}" + (f" — {reason}" if reason else "")
            )
        return status

    def _observe_with_hermes(self, operation: HealingOperation) -> None:
        """Turn the hermes learning cycle, and record what it filed.

        Never raises and never changes the operation's verdict — the healing
        result was decided before this ran. A missing hermes is not a failure
        and not a warning: it is "this feature is not in use on this machine",
        and it costs one `is_dir()` to find out.
        """
        try:
            from hermes.loop import run_cycle

            result = run_cycle(self.project_dir, surface="self-healing")
        except Exception as exc:  # noqa: BLE001 - observation never fails healing
            logger.debug("hermes cycle unavailable: %s", exc)
            return

        if not result.ran:
            return
        # A step only when there is something to report. A "0 proposed" row on
        # every incident is a row nobody reads, and the dashboard renders every
        # step it is given.
        if result.proposed:
            step = operation.add_step("Filing what hermes learned")
            operation.complete_step(
                step,
                "completed",
                f"{result.proposed} candidate(s) in skills/_proposed/ for review",
            )

    def _create_operation(self, incident: Incident) -> HealingOperation:
        """Create a new healing operation for an incident."""
        operation = HealingOperation(incident=incident)
        self._operations.append(operation)
        return operation

    def _find_incident(self, incident_id: str) -> Incident | None:
        """Find an incident by ID."""
        for incident in self._incidents:
            if incident.id == incident_id:
                return incident
        return None

    # ── Persistence ─────────────────────────────────────────────

    def _save_state(self) -> None:
        """Persist current state to JSON files."""
        try:
            incidents_file = self.data_dir / "incidents.json"
            incidents_file.write_text(
                json.dumps(
                    [i.to_dict() for i in self._incidents],
                    indent=2,
                    default=str,
                ),
                encoding="utf-8",
            )

            operations_file = self.data_dir / "operations.json"
            operations_file.write_text(
                json.dumps(
                    [o.to_dict() for o in self._operations],
                    indent=2,
                    default=str,
                ),
                encoding="utf-8",
            )

            fragility_file = self.data_dir / "fragility_reports.json"
            fragility_file.write_text(
                json.dumps(
                    [r.to_dict() for r in self._fragility_reports],
                    indent=2,
                    default=str,
                ),
                encoding="utf-8",
            )
        except OSError as e:
            logger.error(f"Failed to save self-healing state: {e}")

    def _load_state(self) -> None:
        """Load persisted state from JSON files."""
        incidents_file = self.data_dir / "incidents.json"
        if incidents_file.exists():
            try:
                data = json.loads(incidents_file.read_text(encoding="utf-8"))
                self._incidents = [Incident.from_dict(d) for d in data]
                for incident in self._incidents:
                    _reopen_claimed_heal(incident)
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"Failed to load incidents: {e}")

        fragility_file = self.data_dir / "fragility_reports.json"
        if fragility_file.exists():
            try:
                data = json.loads(fragility_file.read_text(encoding="utf-8"))
                self._fragility_reports = [FragilityReport.from_dict(d) for d in data]
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"Failed to load fragility reports: {e}")
