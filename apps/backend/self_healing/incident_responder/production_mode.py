"""
Production Mode - Incident Responder
======================================

Connects to APM tools (Sentry, Datadog, CloudWatch, New Relic, PagerDuty)
via MCP servers. Detects production errors in real-time, correlates with
source code, identifies root cause, and generates fixes with regression tests.

Flow:
1. MCPConnector polls or receives incidents from APM tools
2. on_incident() creates Incident with production context
3. Correlates stack trace with source files
4. Launches production responder agent
5. Agent generates fix + regression test in isolated worktree
6. QA validates -> PR with [hotfix] label
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from .mcp_connector import MCPConnector, MCPSourceConfig
from .models import (
    HealingStatus,
    Incident,
    IncidentMode,
    IncidentSeverity,
    IncidentSource,
    ProductionIncidentData,
)

logger = logging.getLogger(__name__)


class ProductionMode:
    """Production incident detection and response mode."""

    def __init__(self, project_dir: str | Path):
        self.project_dir = Path(project_dir)
        self.connector = MCPConnector()

    async def connect_source(self, config: MCPSourceConfig) -> bool:
        """Connect to a monitoring source."""
        return await self.connector.connect_source(config)

    async def disconnect_source(self, source: IncidentSource) -> bool:
        """Disconnect from a monitoring source."""
        return await self.connector.disconnect_source(source)

    async def poll_incidents(self) -> list[Incident]:
        """Poll all connected sources for new incidents.

        Returns:
            List of new Incident objects from production monitoring.
        """
        raw_incidents = await self.connector.poll_all()
        incidents: list[Incident] = []

        for raw in raw_incidents:
            incident = self._create_incident_from_production_data(raw)
            incidents.append(incident)

        return incidents

    async def on_incident(
        self,
        source: IncidentSource,
        error_data: dict[str, Any],
    ) -> Incident:
        """Handle an incoming production incident.

        Args:
            source: Which monitoring source reported the incident.
            error_data: Raw error data from the source.

        Returns:
            Created Incident ready for healing.
        """
        prod_data = ProductionIncidentData(
            error_type=error_data.get("error_type", "Unknown"),
            error_message=error_data.get("error_message", ""),
            stack_trace=error_data.get("stack_trace", ""),
            occurrence_count=error_data.get("occurrence_count", 1),
            first_seen=error_data.get("first_seen", ""),
            last_seen=error_data.get("last_seen", ""),
            affected_users=error_data.get("affected_users", 0),
            environment=error_data.get("environment", "production"),
            service_name=error_data.get("service_name"),
            event_url=error_data.get("event_url"),
        )

        # Determine severity
        severity = self._assess_severity(prod_data)

        # Correlate with source files
        affected_files = self._correlate_stack_trace(prod_data.stack_trace)
        source_data = prod_data.to_dict()
        if locations := self._stack_locations(prod_data.stack_trace):
            source_data["stack_locations"] = locations

        incident = Incident(
            mode=IncidentMode.PRODUCTION,
            source=source,
            severity=severity,
            title=f"[{source.value}] {prod_data.error_type}: {prod_data.error_message[:100]}",
            description=(
                f"Production error detected by {source.value}. "
                f"Type: {prod_data.error_type}. "
                f"Occurrences: {prod_data.occurrence_count}. "
                f"Affected users: {prod_data.affected_users}."
            ),
            status=HealingStatus.PENDING,
            source_data=source_data,
            affected_files=affected_files,
            error_message=prod_data.error_message,
            stack_trace=prod_data.stack_trace,
        )

        logger.info(
            f"Production incident created: {incident.title} "
            f"(severity={severity.value}, files={len(affected_files)})"
        )
        return incident

    def build_agent_prompt(self, incident: Incident) -> str:
        """Build the prompt for the production incident responder agent."""
        data = incident.source_data
        prompt_path = (
            Path(__file__).parent.parent.parent
            / "prompts"
            / "incident_production_responder.md"
        )

        try:
            template = prompt_path.read_text(encoding="utf-8")
        except FileNotFoundError:
            template = self._fallback_prompt()

        replacements = {
            "{{ERROR_TYPE}}": data.get("error_type", "Unknown"),
            "{{ERROR_MESSAGE}}": data.get("error_message", ""),
            "{{STACK_TRACE}}": data.get("stack_trace", "No stack trace"),
            "{{OCCURRENCE_COUNT}}": str(data.get("occurrence_count", 1)),
            "{{FIRST_SEEN}}": data.get("first_seen", ""),
            "{{LAST_SEEN}}": data.get("last_seen", ""),
            "{{AFFECTED_USERS}}": str(data.get("affected_users", 0)),
            "{{ENVIRONMENT}}": data.get("environment", "production"),
            "{{SERVICE_NAME}}": data.get("service_name") or "unknown",
            "{{AFFECTED_FILES}}": "\n".join(f"- {f}" for f in incident.affected_files),
            "{{STACK_LOCATIONS}}": data.get("stack_locations")
            or "No frame of the stack trace was located in this repository.",
        }

        for key, value in replacements.items():
            template = template.replace(key, value)

        return template

    def _create_incident_from_production_data(
        self, data: ProductionIncidentData
    ) -> Incident:
        """Create an Incident from raw production data."""
        severity = self._assess_severity(data)
        affected_files = self._correlate_stack_trace(data.stack_trace)
        source_data = data.to_dict()
        if locations := self._stack_locations(data.stack_trace):
            source_data["stack_locations"] = locations

        source = IncidentSource.SENTRY  # Default, overridden by connector
        if data.service_name:
            for src in IncidentSource:
                if src.value in (data.service_name or "").lower():
                    source = src
                    break

        return Incident(
            mode=IncidentMode.PRODUCTION,
            source=source,
            severity=severity,
            title=f"{data.error_type}: {data.error_message[:100]}",
            description=f"Occurrences: {data.occurrence_count}, Users: {data.affected_users}",
            status=HealingStatus.PENDING,
            source_data=source_data,
            affected_files=affected_files,
            error_message=data.error_message,
            stack_trace=data.stack_trace,
        )

    def _assess_severity(self, data: ProductionIncidentData) -> IncidentSeverity:
        """Assess incident severity based on production impact."""
        if data.affected_users > 100 or data.occurrence_count > 1000:
            return IncidentSeverity.CRITICAL
        if data.affected_users > 10 or data.occurrence_count > 100:
            return IncidentSeverity.HIGH
        if data.occurrence_count > 10:
            return IncidentSeverity.MEDIUM
        return IncidentSeverity.LOW

    def _trace(self, stack_trace: str):
        """The trace read by `docintel.stacktrace`: the one reader of stack traces.

        It knows the .NET, Python, Node, JVM, Go, Ruby, PHP and Rust formats,
        attaches a frame to a file only on evidence (shared path segments, or a
        single file declaring the class and the method), and folds framework
        frames. None when the text is not a trace or the reader is unavailable.
        """
        if not stack_trace:
            return None
        # One incident asks twice (files, then locations); the repository is
        # walked once.
        cached = getattr(self, "_last_trace", None)
        if cached is not None and cached[0] == stack_trace:
            return cached[1]
        try:
            from docintel.stacktrace import analyze

            trace = analyze(stack_trace, self.project_dir)
        except Exception:  # noqa: BLE001 - a trace nobody could read is not a crash
            logger.debug("stack trace could not be read", exc_info=True)
            trace = None
        self._last_trace = (stack_trace, trace)
        return trace

    def _correlate_stack_trace(self, stack_trace: str) -> list[str]:
        """The project files the stack trace runs through, innermost first."""
        trace = self._trace(stack_trace)
        if trace is None:
            return []
        files = list(dict.fromkeys(f.path for f in trace.project_frames))
        return files[:20]

    def _stack_locations(self, stack_trace: str) -> str:
        """`path:line — Type.method` for each project frame, framework folded."""
        trace = self._trace(stack_trace)
        if trace is None:
            return ""
        from docintel.stacktrace import render_stacktrace

        return render_stacktrace(trace)

    def get_status(self) -> dict[str, Any]:
        """Get production mode status for the dashboard."""
        return {
            "connector": self.connector.get_status(),
            "connected_sources": [s.value for s in self.connector.connected_sources],
        }

    def _fallback_prompt(self) -> str:
        return """## YOUR ROLE - PRODUCTION INCIDENT RESPONDER

You analyze production errors and generate fixes with regression tests.

## ERROR DETAILS
- Type: {{ERROR_TYPE}}
- Message: {{ERROR_MESSAGE}}
- Occurrences: {{OCCURRENCE_COUNT}} since {{FIRST_SEEN}}
- Affected users: {{AFFECTED_USERS}}
- Environment: {{ENVIRONMENT}}

## STACK TRACE
{{STACK_TRACE}}

## AFFECTED FILES
{{AFFECTED_FILES}}

## WHERE IT BROKE
{{STACK_LOCATIONS}}

## INSTRUCTIONS
1. Parse the stack trace to identify the root cause
2. Read the affected source files
3. Generate a fix for the root cause
4. Write a regression test that reproduces the error
5. Ensure the test fails without fix, passes with fix
6. Commit with message: "hotfix: {{ERROR_TYPE}} - [short description]"
"""
