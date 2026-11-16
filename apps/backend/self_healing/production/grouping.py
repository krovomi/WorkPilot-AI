"""One incident per bug, however many tools report it (#372).

An error whose fingerprint (``fingerprint.py``) matches an open production
incident is folded into it instead of opening a second one: the incident is
the group, and one group is one fix attempt. The group keeps, per source and
per external id, the latest counts the tool reported:

- the same external id seen again (a poll that returns the same Sentry issue)
  carries a cumulative counter, so its latest value replaces the old one;
- a report without an id is one event, so it adds up;
- across sources the largest total wins: Sentry and Datadog counting the same
  crash are not twice as many crashes.

The group's severity is the highest of its reports and of what its summed
impact calls for. A second level, root cause clusters, gathers the open
incidents whose most suspect commit is the same: a symptom inherits the
severity of the cluster, and a cluster of many incidents is top priority even
when each of them is minor.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Any

from ..incident_responder.models import (
    HealingStatus,
    Incident,
    IncidentMode,
    IncidentSeverity,
)

__all__ = [
    "absorb",
    "apply_priority_inheritance",
    "find_open_group",
    "max_severity",
    "root_cause_clusters",
    "severity_for_impact",
    "start_group",
]

_ORDER = {
    IncidentSeverity.INFO: 0,
    IncidentSeverity.LOW: 1,
    IncidentSeverity.MEDIUM: 2,
    IncidentSeverity.HIGH: 3,
    IncidentSeverity.CRITICAL: 4,
}
_CLOSED = (HealingStatus.RESOLVED, HealingStatus.PR_CREATED)
_EXTERNAL_ID = re.compile(r"[^A-Za-z0-9._:-]")
MAX_REPORTS = 200
#: A cluster this large is critical; half of it, at least high.
CRITICAL_CLUSTER = 10


def max_severity(*severities: IncidentSeverity) -> IncidentSeverity:
    return max(severities, key=lambda s: _ORDER[s])


def severity_for_impact(occurrences: int, users: int) -> IncidentSeverity:
    """The production mode's thresholds, on one incident or a whole group."""
    if users > 100 or occurrences > 1000:
        return IncidentSeverity.CRITICAL
    if users > 10 or occurrences > 100:
        return IncidentSeverity.HIGH
    if occurrences > 10:
        return IncidentSeverity.MEDIUM
    return IncidentSeverity.LOW


def clean_external_id(value: Any) -> str:
    """A tool's id for its own issue, reduced to a safe alphabet."""
    if value in (None, ""):
        return ""
    return _EXTERNAL_ID.sub("", str(value))[:128]


def _int(value: Any) -> int:
    try:
        return max(int(value), 0)
    except (TypeError, ValueError):
        return 0


def _report(incident: Incident) -> tuple[str, dict[str, Any]]:
    data = incident.source_data
    external_id = clean_external_id(data.get("external_id"))
    key = f"{incident.source.value}:{external_id or incident.id}"
    return key, {
        "source": incident.source.value,
        "external_id": external_id,
        "occurrences": _int(data.get("occurrence_count", 1)),
        "users": _int(data.get("affected_users", 0)),
        "last_seen": str(data.get("last_seen") or incident.created_at),
        "seen": 1,
    }


def _totals(reports: dict[str, dict[str, Any]]) -> tuple[int, int, list[str]]:
    per_source: dict[str, list[int]] = {}
    for report in reports.values():
        totals = per_source.setdefault(report["source"], [0, 0])
        totals[0] += report["occurrences"]
        totals[1] += report["users"]
    occurrences = max((t[0] for t in per_source.values()), default=0)
    users = max((t[1] for t in per_source.values()), default=0)
    return occurrences, users, sorted(per_source)


def _refresh(incident: Incident) -> None:
    group = incident.source_data["group"]
    occurrences, users, sources = _totals(group["reports"])
    group["sources"] = sources
    group["report_count"] = sum(r["seen"] for r in group["reports"].values())
    incident.source_data["occurrence_count"] = occurrences
    incident.source_data["affected_users"] = users
    incident.severity = max_severity(
        incident.severity, severity_for_impact(occurrences, users)
    )


def start_group(incident: Incident) -> None:
    """Make ``incident`` the group of its own fingerprint."""
    key, report = _report(incident)
    incident.source_data["group"] = {
        "reports": {key: report},
        "sources": [report["source"]],
        "report_count": 1,
    }
    _refresh(incident)


def find_open_group(incidents: Iterable[Incident], fingerprint: str) -> Incident | None:
    """The open production incident that already carries this fingerprint."""
    if not fingerprint:
        return None
    for incident in incidents:
        if (
            incident.mode == IncidentMode.PRODUCTION
            and incident.status not in _CLOSED
            and incident.source_data.get("fingerprint") == fingerprint
        ):
            return incident
    return None


def absorb(group_incident: Incident, incident: Incident) -> None:
    """Fold ``incident`` (same fingerprint) into ``group_incident``."""
    if "group" not in group_incident.source_data:
        start_group(group_incident)
    group = group_incident.source_data["group"]
    reports: dict[str, dict[str, Any]] = group["reports"]
    key, report = _report(incident)
    previous = reports.get(key)
    if previous is not None and report["external_id"]:
        # The same issue of the same tool: its counters are cumulative.
        previous["occurrences"] = max(previous["occurrences"], report["occurrences"])
        previous["users"] = max(previous["users"], report["users"])
        previous["last_seen"] = max(previous["last_seen"], report["last_seen"])
        previous["seen"] += 1
    elif len(reports) < MAX_REPORTS:
        reports[key] = report
    else:
        # Bounded: past the cap, an event still counts, on its source's first row.
        same_source = [r for r in reports.values() if r["source"] == report["source"]]
        oldest = same_source[0] if same_source else next(iter(reports.values()))
        oldest["occurrences"] += report["occurrences"]
        oldest["users"] += report["users"]
        oldest["seen"] += 1
    data = group_incident.source_data
    data["last_seen"] = max(str(data.get("last_seen") or ""), report["last_seen"])
    group_incident.severity = max_severity(group_incident.severity, incident.severity)
    for path in incident.affected_files:
        if path not in group_incident.affected_files:
            group_incident.affected_files.append(path)
    _refresh(group_incident)


def _open_production(incidents: Iterable[Incident]) -> list[Incident]:
    return [
        i
        for i in incidents
        if i.mode == IncidentMode.PRODUCTION and i.status not in _CLOSED
    ]


def root_cause_clusters(incidents: Sequence[Incident]) -> list[dict[str, Any]]:
    """Open production incidents that share their most suspect commit."""
    by_commit: dict[str, list[Incident]] = {}
    for incident in _open_production(incidents):
        suspects = incident.source_data.get("suspect_commits") or []
        if suspects and isinstance(suspects[0], dict) and suspects[0].get("sha"):
            by_commit.setdefault(str(suspects[0]["sha"]), []).append(incident)
    clusters: list[dict[str, Any]] = []
    for sha, members in by_commit.items():
        if len(members) < 2:
            continue
        occurrences = sum(_int(m.source_data.get("occurrence_count")) for m in members)
        users = sum(_int(m.source_data.get("affected_users")) for m in members)
        severity = max_severity(
            *(m.severity for m in members), severity_for_impact(occurrences, users)
        )
        if len(members) >= CRITICAL_CLUSTER:
            severity = IncidentSeverity.CRITICAL
        elif len(members) * 2 >= CRITICAL_CLUSTER:
            severity = max_severity(severity, IncidentSeverity.HIGH)
        first = members[0].source_data["suspect_commits"][0]
        sources = sorted(
            {
                s
                for m in members
                for s in m.source_data.get("group", {}).get("sources", [])
            }
            | {m.source.value for m in members}
        )
        clusters.append(
            {
                "id": sha[:12],
                "commit": sha,
                "subject": str(first.get("subject", ""))[:200],
                "incident_ids": [m.id for m in members],
                "severity": severity.value,
                "occurrences": occurrences,
                "affected_users": users,
                "sources": sources,
            }
        )
    clusters.sort(
        key=lambda c: (_ORDER[IncidentSeverity(c["severity"])], len(c["incident_ids"])),
        reverse=True,
    )
    return clusters


def apply_priority_inheritance(incidents: Sequence[Incident]) -> list[dict[str, Any]]:
    """Raise each clustered incident to its cluster's severity; returns the clusters."""
    clusters = root_cause_clusters(incidents)
    by_id = {i.id: i for i in incidents}
    for cluster in clusters:
        severity = IncidentSeverity(cluster["severity"])
        for incident_id in cluster["incident_ids"]:
            incident = by_id[incident_id]
            incident.source_data["cluster_id"] = cluster["id"]
            if _ORDER[incident.severity] < _ORDER[severity]:
                incident.source_data.setdefault(
                    "inherited_from",
                    {"commit": cluster["commit"], "severity": incident.severity.value},
                )
                incident.severity = severity
    return clusters
