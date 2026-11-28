"""The QA security report ranked by reach and production use (issue #364)."""

from __future__ import annotations

import json

import pytest
from security import qa_scanner
from security.finding_priority import Evidence, PriorityContext, Reach
from security.qa_scanner import SecurityScanSummary, run_qa_security_scan
from security.vulnerability_scanner import (
    ScanResult,
    Severity,
    Vulnerability,
    VulnerabilitySource,
)
from security_reach import RUNTIME_OFF_NOTE, evidence_for


@pytest.fixture
def no_tools(monkeypatch):
    def scan_all(self, **_kinds):
        return ScanResult(project_path=self.project_path)

    monkeypatch.setattr(qa_scanner.VulnerabilityScanner, "scan_all", scan_all)


def _write(root, rel, text):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


async def test_the_report_puts_what_runs_in_production_first(tmp_path, no_tools):
    project, spec = tmp_path / "shop", tmp_path / "spec"
    spec.mkdir()
    _write(
        project, "api/app.py", "from api import orders\n@app.get('/o')\ndef o(): ...\n"
    )
    _write(project, "api/orders.py", "def find(q):\n    return eval(q)\n")
    _write(project, "api/legacy.py", "def old(q):\n    return eval(q)\n")
    _write(project, "tests/test_orders.py", "def test_x():\n    eval('1')\n")
    _write(
        project,
        ".workpilot/incidents/sentry.json",
        json.dumps(
            {
                "event": {
                    "exception": {
                        "values": [
                            {
                                "stacktrace": {
                                    "frames": [
                                        {
                                            "filename": "/srv/shop/api/orders.py",
                                            "lineno": 2,
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                }
            }
        ),
    )

    passed, section, issues = await run_qa_security_scan(
        project, spec, evidence=evidence_for
    )

    # The verdict still follows severity: every high finding is still there.
    assert passed is False
    assert [i["location"] for i in issues] == [
        "api/orders.py:2",
        "api/legacy.py:2",
        "tests/test_orders.py:2",
    ]
    assert [i["section"] for i in issues] == [
        "critical_exposed",
        "critical_dormant",  # dynamic code (``eval``) makes its reach uncertain
        "informational",
    ]
    assert issues[0]["priority"] > issues[1]["priority"] > issues[2]["priority"]
    assert (
        "**Priority:** 🔴 Critical & exposed: 1 | 🟠 Critical but dormant: 1" in section
    )
    assert section.index("### 🔴 Critical & exposed (1)") < section.index(
        "api/orders.py:2"
    )
    assert "seen in production ×1" in section
    assert "what blocks the build still follows severity" in section


async def test_no_finding_asks_for_no_evidence(tmp_path, no_tools):
    def refuse(*_args):
        raise AssertionError("not asked")

    spec = tmp_path / "spec"
    spec.mkdir()
    passed, section, issues = await run_qa_security_scan(
        tmp_path, spec, evidence=refuse
    )
    assert (passed, issues) == (True, [])
    assert "No security issues detected" in section


def test_a_ranked_report_names_its_notes_dependencies_and_errors(tmp_path):
    finding = Vulnerability(
        id="GHSA-1",
        severity=Severity.MEDIUM,
        source=VulnerabilitySource.NPM_AUDIT,
        title="Vulnerable dependency: lodash",
        description="Prototype pollution",
        dependency="lodash@<4.17.21",
    )
    result = ScanResult(project_path=tmp_path, vulnerabilities=[finding])
    result.scan_errors.append("npm audit timed out")
    summary = SecurityScanSummary(scan_result=result)
    summary.apply_priorities(
        PriorityContext(
            [Evidence(Reach.UNCERTAIN, transitive=True)], notes=[RUNTIME_OFF_NOTE]
        )
    )
    text = summary.to_markdown()
    assert f"> ℹ️ {RUNTIME_OFF_NOTE}" in text
    assert "### 🟡 Medium (1)" in text
    assert "  - Dependency: `lodash@<4.17.21`" in text
    assert "uncertain, transitive" in text
    assert text.rstrip().endswith("- npm audit timed out")
    assert summary.to_qa_issues() == []
