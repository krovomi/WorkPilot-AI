"""
Incident Responder Orchestrator
=================================

Unified coordinator for all three self-healing modes:
- CI/CD Mode: Test regression detection and auto-fix
- Production Mode: APM incident response
- Proactive Mode: Fragility analysis and preventive testing

Manages the healing lifecycle: detection -> analysis -> fix card -> PR.
The fix is a card on the project's board (`fix_card.py`): its build plans,
codes and runs QA in a worktree, then waits for a person's review before its
pull request, and the incident follows the card. Persists incidents and
operations to JSON for dashboard display.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Any

from ..cicd import bisect as cicd_bisect
from ..cicd import flow as cicd_flow
from ..cicd import green as cicd_green
from ..cicd import triggers as cicd_triggers
from ..production import grouping
from . import fix_card
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

# What an incident stored by the placeholder pipeline (before the fix cards)
# was told: it analysed, named fix, QA and PR steps it never ran (F48) and
# sent the incident to a person.
NEEDS_A_PERSON = (
    "No fix was generated: the healing pipeline analysed this incident before "
    "fixes were filed as cards, so a person has to take it from here."
)

FILE_CARD_STEP = "Filing a fix card on the board"
CARD_FILED = (
    "card {card} in the backlog: its build plans, codes and runs QA in a "
    "worktree, then waits for your review before its pull request"
)
CARD_STILL_OPEN = "card {card} is still on the board: restart it or follow it there"
APP_FAILS = (
    "\n\nBefore any change, the app as it stands fails its runtime "
    "verification: make it start again first."
)

# The statuses the placeholder pipeline left behind on an incident it claimed
# to have healed: `pr_created`, or `qa_running` when PR creation was off.
_CLAIMED_HEALED = (HealingStatus.PR_CREATED, HealingStatus.QA_RUNNING)


GROUPED_STEP = "Grouping with an open incident"

# An incident in one of these states is over: a new report opens a new one.
_CLOSED = (HealingStatus.RESOLVED, HealingStatus.FAILED)


def _grouped_operation(group: Incident, incident: Incident) -> HealingOperation:
    """What the caller gets back for a report folded into an open incident.

    Not kept in the operations list: no healing ran for it.
    """
    operation = HealingOperation(incident=group)
    step = operation.add_step(GROUPED_STEP)
    reports = group.source_data.get("group", {}).get("report_count", 1)
    sources = ", ".join(group.source_data.get("group", {}).get("sources", []))
    operation.complete_step(
        step,
        "completed",
        f"same fingerprint as incident {group.id} ({incident.source.value}); "
        f"{reports} report(s) from {sources}: one fix covers them",
    )
    operation.finalize(success=False)
    return operation


def _resolution_seconds(incident: Incident) -> float | None:
    """Seconds from the incident's report to its resolution, if it has one."""
    if incident.status != HealingStatus.RESOLVED or not incident.resolved_at:
        return None
    try:
        started = datetime.fromisoformat(incident.created_at)
        ended = datetime.fromisoformat(incident.resolved_at)
    except ValueError:
        return None
    seconds = (ended - started).total_seconds()
    return seconds if seconds > 0 else None


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
    incident detection to the fix card that resolves it.
    """

    def __init__(
        self,
        project_dir: str | Path,
        data_dir: str | Path | None = None,
        risk_threshold: float = 40.0,
        max_files: int = 100,
        auto_fix: bool = True,
        auto_fix_production: bool = False,
        auto_bisect: bool = True,
    ):
        self.project_dir = Path(project_dir)
        self.data_dir = (
            Path(data_dir)
            if data_dir
            else self.project_dir / ".workpilot" / "self-healing"
        )
        # A CI/CD failure gets its fix card on its own when `auto_fix` is
        # on; a production incident when `auto_fix_production` is (both
        # settings of the view). Off, the incident waits for "Fix".
        self.auto_fix = auto_fix
        self.auto_fix_production = auto_fix_production
        self.auto_bisect = auto_bisect
        self.bisect_budget = cicd_bisect.BisectBudget()

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
        good_sha: str | None = None,
    ) -> HealingOperation:
        """Handle a CI/CD test failure end-to-end.

        Creates an incident, reads the bisect triggers, bisects when one fires
        and a green commit is known (#375), starts a healing operation, and if
        auto_fix is enabled, proceeds through the full healing pipeline.
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
        good = good_sha if cicd_triggers.is_commit_sha(good_sha) else None
        good = good or cicd_green.last_green(self.project_dir, branch) or None
        if good:
            incident.source_data["last_green"] = good
        triggers = cicd_triggers.evaluate_triggers(
            self.project_dir,
            commit_sha,
            incident.source_data.get("failing_tests") or [],
            good,
        )
        incident.source_data["bisect_triggers"] = triggers.to_dict()
        if self.auto_bisect and triggers.fired and good:
            await self._bisect(incident, good)

        operation = self._create_operation(incident)

        if self.auto_fix:
            await self._run_healing_pipeline(operation, incident)

        self._save_state()
        return operation

    async def bisect_incident(
        self,
        incident_id: str,
        good_sha: str | None = None,
        on_step: cicd_bisect.StepCallback | None = None,
    ) -> cicd_bisect.BisectResult | None:
        """Bisect a CI/CD incident on demand; ``None`` when it is not one."""
        incident = self._find_incident(incident_id)
        if incident is None or incident.mode != IncidentMode.CICD:
            return None
        good = good_sha if cicd_triggers.is_commit_sha(good_sha) else None
        good = (
            good
            or incident.source_data.get("last_green")
            or cicd_green.last_green(
                self.project_dir, str(incident.source_data.get("branch") or "")
            )
        )
        if not good:
            result = cicd_bisect.BisectResult(
                "unavailable",
                bad=str(incident.source_data.get("commit_sha") or ""),
                reason="no green commit is known for this branch",
            )
            incident.source_data["bisect"] = result.to_dict()
            self._save_state()
            return result
        incident.source_data["last_green"] = good
        result = await self._bisect(incident, good, on_step)
        self._save_state()
        return result

    async def _bisect(
        self,
        incident: Incident,
        good: str,
        on_step: cicd_bisect.StepCallback | None = None,
    ) -> cicd_bisect.BisectResult:
        result = await asyncio.to_thread(
            cicd_bisect.run_bisect,
            self.project_dir,
            good,
            str(incident.source_data.get("commit_sha") or ""),
            incident.source_data.get("failing_tests") or [],
            budget=self.bisect_budget,
            on_step=on_step,
        )
        cicd_flow.apply_bisect(incident, result, self.cicd._get_commit_diff)
        return result

    # ── Production Mode ─────────────────────────────────────────

    async def handle_production_incident(
        self,
        source: IncidentSource,
        error_data: dict[str, Any],
    ) -> HealingOperation:
        """Handle a production incident end-to-end."""
        incident = await self.production.on_incident(source, error_data)

        group = self._file_production_incident(incident)
        if group is not None:
            # The same fingerprint as an open incident: one bug, one fix
            # attempt. The report is counted on the group, nothing else runs.
            self._save_state()
            return _grouped_operation(group, incident)

        operation = self._create_operation(incident)

        if self.auto_fix_production:
            await self._run_healing_pipeline(operation, incident)

        grouping.apply_priority_inheritance(self._incidents)
        self._save_state()
        return operation

    def _file_production_incident(self, incident: Incident) -> Incident | None:
        """Fold ``incident`` into the open incident of its fingerprint, or keep it.

        Returns the group it joined, ``None`` when it opens a group of its own.
        """
        fingerprint = str(incident.source_data.get("fingerprint") or "")
        group = grouping.find_open_group(self._incidents, fingerprint)
        if group is None:
            self._incidents.append(incident)
            return None
        grouping.absorb(group, incident)
        grouping.apply_priority_inheritance(self._incidents)
        return group

    async def connect_production_source(self, config: MCPSourceConfig) -> bool:
        """Connect to a production monitoring source."""
        return await self.production.connect_source(config)

    async def disconnect_production_source(self, source: IncidentSource) -> bool:
        """Disconnect from a production monitoring source."""
        return await self.production.disconnect_source(source)

    async def poll_production_incidents(self) -> list[Incident]:
        """Poll all connected production sources for new incidents."""
        incidents = await self.production.poll_incidents()
        opened = [i for i in incidents if self._file_production_incident(i) is None]
        grouping.apply_priority_inheritance(self._incidents)
        self._save_state()
        return opened

    # ── Proactive Mode ──────────────────────────────────────────

    async def run_proactive_scan(self) -> list[FragilityReport]:
        """Run a proactive fragility scan.

        Returns fragility reports and creates incidents for the most risky files.
        """
        reports = await self.proactive.scan_fragility()
        self._fragility_reports = reports

        # Create incidents for top risky files. A file that still has an open
        # incident from an earlier scan keeps it, with today's measures.
        incidents = await self.proactive.create_incidents_from_scan(reports)
        open_by_file = {
            i.affected_files[0]: i
            for i in self._incidents
            if i.mode == IncidentMode.PROACTIVE
            and i.affected_files
            and i.status not in _CLOSED
        }
        for incident in incidents:
            known = open_by_file.get(incident.affected_files[0])
            if known is None:
                self._incidents.append(incident)
                continue
            known.title = incident.title
            known.description = incident.description
            known.severity = incident.severity
            known.source_data = incident.source_data

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
            # A finished operation has nothing left to cancel, and its
            # incident keeps the verdict it reached.
            if op.id == operation_id and not op.completed_at:
                op.finalize(success=False)
                if op.incident:
                    op.incident.status = HealingStatus.FAILED
                self._save_state()
                return True
        return False

    # ── Dashboard Data ──────────────────────────────────────────

    def get_dashboard_data(self) -> dict[str, Any]:
        """Get all data needed for the dashboard, incidents read from their cards."""
        self.refresh_from_board()
        return {
            "incidents": [i.to_dict() for i in self._incidents],
            "activeOperations": [
                o.to_dict() for o in self._operations if not o.completed_at
            ],
            "fragilityReports": [r.to_dict() for r in self._fragility_reports],
            "stats": self.get_stats().to_dict(),
            "productionStatus": self.production.get_status(),
            "proactiveSummary": self.proactive.get_summary(),
            "riskTrends": self.proactive.trend_report(),
            "incidentClusters": grouping.root_cause_clusters(self._incidents),
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

        # Average resolution time: from the report to the incident resolved.
        resolution_times = [
            t for i in self._incidents if (t := _resolution_seconds(i)) is not None
        ]
        avg_time = (
            sum(resolution_times) / len(resolution_times) if resolution_times else 0.0
        )

        # Auto-fix rate: incidents whose fix card reached its pull request.
        # Filing a card is not a fix, so the operation's outcome is not read.
        auto_fixed = sum(
            1
            for i in self._incidents
            if i.fix_card
            and i.status in (HealingStatus.PR_CREATED, HealingStatus.RESOLVED)
        )
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

        Steps: analyze -> verify -> fix card

        Analysis builds the mode-specific prompt, the runtime verification
        launches the app, and the fix is filed as a card on the board: its
        build codes the fix and runs QA in a worktree, and the incident
        follows it (`refresh_from_board`) up to its pull request.
        """
        try:
            # Step 1: Analyze
            step = operation.add_step("Analyzing incident")
            incident.status = HealingStatus.ANALYZING

            # Build mode-specific agent prompt (one builder per mode).
            builder = {
                IncidentMode.CICD: self.cicd,
                IncidentMode.PRODUCTION: self.production,
                IncidentMode.PROACTIVE: self.proactive,
            }[incident.mode]
            prompt = builder.build_agent_prompt(incident)

            operation.complete_step(
                step, "completed", f"Prompt built ({len(prompt)} chars)"
            )

            # Step 2: the app, launched, as it stands before any fix. An app
            # that no longer starts is the first thing the fix has to address,
            # so the card says so; it does not stop the card.
            if await self._verify_runtime(operation) == "fail":
                prompt += APP_FAILS

            # Step 3: the fix card. One per incident while it is on the board.
            step = operation.add_step(FILE_CARD_STEP)
            state = (
                fix_card.card_state(self.project_dir, incident.fix_card)
                if incident.fix_card
                else None
            )
            if state is not None:
                fix_card.follow(incident, state)
                operation.complete_step(
                    step, "skipped", CARD_STILL_OPEN.format(card=incident.fix_card)
                )
                operation.finalize(success=False)
                return
            card = fix_card.file_card(self.project_dir, incident, prompt)
            incident.fix_card = card
            incident.status = HealingStatus.FIXING
            incident.error_message = None
            operation.complete_step(step, "completed", CARD_FILED.format(card=card))
            operation.finalize(success=True)
            logger.info(f"Incident {incident.id}: fix card {card} filed")

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

    def refresh_from_board(self) -> bool:
        """Bring each incident with a fix card to where its card stands.

        An incident a person dismissed, or whose card is done, is left as it
        is. Saved when anything changed; returns whether it did.
        """
        changed = False
        for incident in self._incidents:
            if not incident.fix_card or incident.status == HealingStatus.RESOLVED:
                continue
            state = fix_card.card_state(self.project_dir, incident.fix_card)
            changed |= fix_card.follow(incident, state)
        if changed:
            self._save_state()
        return changed

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
            except (OSError, ValueError) as e:
                logger.warning(f"Failed to load incidents: {e}")
                data = []
            # One entry that no longer reads (a status this version does not
            # know) is skipped; the next save would otherwise drop them all.
            for entry in data if isinstance(data, list) else []:
                try:
                    incident = Incident.from_dict(entry)
                except (AttributeError, KeyError, TypeError, ValueError) as e:
                    logger.warning(f"Skipped an incident that does not load: {e}")
                    continue
                _reopen_claimed_heal(incident)
                self._incidents.append(incident)

        fragility_file = self.data_dir / "fragility_reports.json"
        if fragility_file.exists():
            try:
                data = json.loads(fragility_file.read_text(encoding="utf-8"))
                self._fragility_reports = [FragilityReport.from_dict(d) for d in data]
            except (json.JSONDecodeError, KeyError) as e:
                logger.warning(f"Failed to load fragility reports: {e}")
