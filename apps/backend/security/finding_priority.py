"""Which security findings to fix first (issue #364).

A scan of a large repository lists hundreds of findings, most of them in code
that never runs where it matters. This module ranks them: each finding gets a
priority, ``base × reach × runtime``, and one of four sections:

1. **Critical & exposed**: critical or high, in code that runs in production
   (an incident's stack trace went through it), or, without any production
   data, in code reached from an entry point;
2. **Critical but dormant**: critical or high, not seen running;
3. **Medium**: everything else that is reached or may be;
4. **Informational**: code that no entry point reaches, and test code.

The ranking only orders and groups. It never removes a finding, and it never
changes what blocks a build: that still follows the scanner's severity, so a
reachability analysis that is wrong cannot hide a critical finding. A secret
written in the repository is exposed wherever it sits, so it is never
informational.

The evidence (what reaches what, what ran in production) is gathered by
``security_reach``, outside this package; this module only scores it.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from enum import Enum

from .vulnerability_scanner import Severity, Vulnerability, VulnerabilitySource

__all__ = [
    "Evidence",
    "EvidenceProvider",
    "PriorityContext",
    "RankedFinding",
    "Reach",
    "Section",
    "rank",
]


class Reach(str, Enum):
    """How the code of a finding is reached from the project's entry points."""

    REACHED = "reached"
    UNREACHED = "unreached"
    #: Reached only through code loaded by name (reflection, ``eval``…), or a
    #: dependency only pulled in by another one.
    UNCERTAIN = "uncertain"
    TEST = "test"
    #: No entry point was found, or the finding has no file.
    UNKNOWN = "unknown"


class Section(str, Enum):
    CRITICAL_EXPOSED = "critical_exposed"
    CRITICAL_DORMANT = "critical_dormant"
    MEDIUM = "medium"
    INFORMATIONAL = "informational"


SECTION_TITLES = {
    Section.CRITICAL_EXPOSED: "🔴 Critical & exposed",
    Section.CRITICAL_DORMANT: "🟠 Critical but dormant",
    Section.MEDIUM: "🟡 Medium",
    Section.INFORMATIONAL: "🟢 Informational",
}

#: A severity without a CVSS score counts as the middle of its CVSS band.
_BASE = {
    Severity.CRITICAL: 9.5,
    Severity.HIGH: 7.5,
    Severity.MEDIUM: 5.0,
    Severity.LOW: 2.5,
    Severity.INFO: 0.5,
}
_REACH_FACTOR = {
    Reach.REACHED: 1.0,
    Reach.UNCERTAIN: 0.8,
    Reach.UNKNOWN: 0.8,
    Reach.UNREACHED: 0.3,
    Reach.TEST: 0.2,
}
#: Seen in production, not seen while production data exists, no data at all.
_RUNTIME_HIT, _RUNTIME_QUIET, _RUNTIME_OFF = 1.5, 0.8, 1.0


@dataclass(frozen=True)
class Evidence:
    """What is known of one finding's code."""

    reach: Reach = Reach.UNKNOWN
    #: Production incidents whose stack went through the finding's code.
    runtime_hits: int = 0
    #: Users those incidents affected, when the monitoring tool says so.
    users: int = 0
    #: A dependency the project does not declare itself.
    transitive: bool = False
    #: The project loads code by name, so the reach of unreached code is a guess.
    dynamic: bool = False


@dataclass
class PriorityContext:
    """The evidence for each finding of a scan, in the scan's order."""

    evidence: list[Evidence] = field(default_factory=list)
    #: Production data was read (an APM inbox with recent incidents).
    runtime_available: bool = False
    #: The analysis found at least one entry point.
    entry_points: int = 0
    #: Why a part of the analysis did not run, for the report.
    notes: list[str] = field(default_factory=list)


#: ``provider(project_dir, findings)``: the evidence for each finding.
EvidenceProvider = Callable[[object, list[Vulnerability]], PriorityContext]


@dataclass(frozen=True)
class RankedFinding:
    vulnerability: Vulnerability
    evidence: Evidence
    priority: float
    section: Section

    @property
    def tags(self) -> list[str]:
        tags = [self.evidence.reach.value]
        if self.evidence.runtime_hits:
            tags.append(f"seen in production ×{self.evidence.runtime_hits}")
        if self.evidence.users:
            tags.append(f"{self.evidence.users} users affected")
        if self.evidence.transitive:
            tags.append("transitive")
        if self.evidence.dynamic:
            tags.append("dynamic code detected, reachability uncertain")
        return tags


def _is_secret(vulnerability: Vulnerability) -> bool:
    return (
        vulnerability.source == VulnerabilitySource.SECRETS
        or vulnerability.cwe == "CWE-798"
    )


def _base(vulnerability: Vulnerability) -> float:
    score = vulnerability.cvss_score
    if isinstance(score, int | float) and 0 < score <= 10:
        return float(score)
    return _BASE[vulnerability.severity]


def _score(
    vulnerability: Vulnerability, evidence: Evidence, runtime_available: bool
) -> float:
    reach = Reach.REACHED if _is_secret(vulnerability) else evidence.reach
    if evidence.runtime_hits:
        runtime = _RUNTIME_HIT
    elif runtime_available:
        runtime = _RUNTIME_QUIET
    else:
        runtime = _RUNTIME_OFF
    return round(_base(vulnerability) * _REACH_FACTOR[reach] * runtime, 2)


def _section(
    vulnerability: Vulnerability, evidence: Evidence, runtime_available: bool
) -> Section:
    secret = _is_secret(vulnerability)
    if not secret and evidence.reach in (Reach.UNREACHED, Reach.TEST):
        return Section.INFORMATIONAL
    if vulnerability.severity not in (Severity.CRITICAL, Severity.HIGH):
        return Section.MEDIUM
    if evidence.runtime_hits:
        return Section.CRITICAL_EXPOSED
    # Without production data, reaching the code from an entry point is the
    # best sign that it runs; with it, only a production stack is.
    if not runtime_available and (secret or evidence.reach == Reach.REACHED):
        return Section.CRITICAL_EXPOSED
    return Section.CRITICAL_DORMANT


_ORDER = list(Section)


def rank(
    findings: Iterable[Vulnerability], context: PriorityContext
) -> list[RankedFinding]:
    """Every finding, by section then by priority, highest first."""
    ranked = []
    for index, vulnerability in enumerate(findings):
        evidence = (
            context.evidence[index] if index < len(context.evidence) else Evidence()
        )
        ranked.append(
            RankedFinding(
                vulnerability=vulnerability,
                evidence=evidence,
                priority=_score(vulnerability, evidence, context.runtime_available),
                section=_section(vulnerability, evidence, context.runtime_available),
            )
        )
    ranked.sort(key=lambda r: (_ORDER.index(r.section), -r.priority))
    return ranked
