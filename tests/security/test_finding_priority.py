"""The ranking of a security scan's findings (issue #364)."""

from __future__ import annotations

from security.finding_priority import (
    Evidence,
    PriorityContext,
    Reach,
    Section,
    rank,
)
from security.vulnerability_scanner import Severity, Vulnerability, VulnerabilitySource


def _finding(severity=Severity.CRITICAL, source=VulnerabilitySource.BANDIT, **kw):
    return Vulnerability(
        id=kw.pop("id", "V"),
        severity=severity,
        source=source,
        title="t",
        description="d",
        **kw,
    )


def _one(finding, evidence, runtime=False):
    (ranked,) = rank([finding], PriorityContext([evidence], runtime_available=runtime))
    return ranked


def test_a_critical_finding_seen_in_production_is_exposed_and_scores_highest():
    ranked = _one(_finding(), Evidence(Reach.REACHED, runtime_hits=3, users=40), True)
    assert ranked.section == Section.CRITICAL_EXPOSED
    assert ranked.priority == 14.25  # 9.5 × 1 × 1.5
    assert ranked.tags == ["reached", "seen in production ×3", "40 users affected"]


def test_with_production_data_only_a_production_stack_makes_a_finding_exposed():
    ranked = _one(_finding(), Evidence(Reach.REACHED), runtime=True)
    assert (ranked.section, ranked.priority) == (Section.CRITICAL_DORMANT, 7.6)


def test_without_production_data_reaching_the_code_is_the_sign_it_runs():
    assert _one(_finding(), Evidence(Reach.REACHED)).section == Section.CRITICAL_EXPOSED
    uncertain = _one(_finding(), Evidence(Reach.UNCERTAIN, dynamic=True))
    assert uncertain.section == Section.CRITICAL_DORMANT
    assert "dynamic code detected, reachability uncertain" in uncertain.tags


def test_unreached_and_test_code_is_informational_whatever_its_severity():
    for reach, priority in ((Reach.UNREACHED, 2.85), (Reach.TEST, 1.9)):
        ranked = _one(_finding(), Evidence(reach))
        assert (ranked.section, ranked.priority) == (Section.INFORMATIONAL, priority)


def test_a_secret_is_exposed_wherever_it_is_written():
    secret = _finding(source=VulnerabilitySource.SECRETS)
    ranked = _one(secret, Evidence(Reach.TEST))
    assert (ranked.section, ranked.priority) == (Section.CRITICAL_EXPOSED, 9.5)
    pattern = _finding(source=VulnerabilitySource.CUSTOM, cwe="CWE-798")
    assert _one(pattern, Evidence(Reach.UNREACHED)).section == Section.CRITICAL_EXPOSED
    # With production data and no stack through it, it is still not hidden.
    assert _one(secret, Evidence(Reach.TEST), True).section == Section.CRITICAL_DORMANT


def test_lower_severities_go_to_medium_and_a_cvss_score_replaces_the_band():
    medium = _one(_finding(Severity.MEDIUM, cvss_score=6.1), Evidence(Reach.REACHED))
    assert (medium.section, medium.priority) == (Section.MEDIUM, 6.1)
    low = _one(_finding(Severity.LOW, cvss_score=42.0), Evidence(Reach.UNKNOWN))
    assert (low.section, low.priority) == (Section.MEDIUM, 2.0)
    transitive = _one(
        _finding(Severity.INFO), Evidence(Reach.UNCERTAIN, transitive=True)
    )
    assert transitive.tags == ["uncertain", "transitive"]


def test_findings_are_ordered_by_section_then_priority_and_none_is_dropped():
    findings = [
        _finding(id="dormant"),
        _finding(Severity.LOW, id="low"),
        _finding(id="exposed"),
        _finding(Severity.HIGH, id="exposed-high"),
        _finding(id="no-evidence"),
    ]
    context = PriorityContext(
        [
            Evidence(Reach.UNCERTAIN),
            Evidence(Reach.REACHED),
            Evidence(Reach.REACHED, runtime_hits=1),
            Evidence(Reach.REACHED, runtime_hits=9),
        ],
        runtime_available=True,
    )
    order = [r.vulnerability.id for r in rank(findings, context)]
    assert order == ["exposed", "exposed-high", "dormant", "no-evidence", "low"]
