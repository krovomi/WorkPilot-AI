"""SecurityReportGenerator: each format says what the scan found, and only that."""

from __future__ import annotations

import builtins
import importlib
import json
import sys

import pytest
from security import security_report_generator as srg
from security.security_report_generator import SecurityReportGenerator

CRITICAL = {
    "id": "SECRET-1a2b3c4d",
    "severity": "critical",
    "source": "secrets",
    "title": "Hardcoded secret: AWS Access Key",
    "description": "Potential AWS Access Key found in code",
    "file": "config.py",
    "line": 3,
    "remediation": "Use an environment variable",
    "references": ["https://owasp.org/secrets", ""],
}
HIGH = {
    "id": "B602",
    "severity": "high",
    "source": "bandit",
    "title": "shell=True",
    "file": "run.py",
    "remediation": "Pass a list",
}
DEPENDENCY = {
    "id": "GHSA-1",
    "severity": "medium",
    "source": "npm_audit",
    "title": "Vulnerable dependency: minimist",
    "dependency": "minimist@<0.2.4",
}


def _scan(*vulns, **extra):
    counts = {
        s: sum(1 for v in vulns if v["severity"] == s)
        for s in ("critical", "high", "medium", "low")
    }
    return {
        "project_path": "/work/app",
        "vulnerabilities": list(vulns),
        "summary": {**counts, "total": len(vulns)},
        "scans_run": ["secrets", "bandit"],
        "total_files_scanned": 12,
        "scan_duration_seconds": 1.5,
        "should_block": counts["critical"] > 0,
        "should_warn": counts["high"] + counts["medium"] > 0,
        **extra,
    }


COMPLIANCE = {
    "frameworks": ["GDPR", "SOC2"],
    "violations": [
        {
            "framework": "SOC2",
            "rule_id": "SOC2-CC6.1",
            "severity": "critical",
            "title": "Hardcoded password",
            "file": "settings.py",
            "remediation": "Use a vault",
        },
        {
            "framework": "GDPR",
            "rule_id": "GDPR-ART6",
            "severity": "high",
            "title": "Email",
        },
    ],
    "summary": {"critical": 1, "high": 1, "total": 2, "is_compliant": False},
}


@pytest.fixture
def gen():
    return SecurityReportGenerator()


@pytest.mark.parametrize(
    ("summary", "compliance", "score", "level"),
    [
        ({}, None, 0, "LOW"),
        ({"medium": 3, "low": 2}, None, 11, "LOW"),
        ({"high": 2}, None, 20, "MEDIUM"),
        (
            {"critical": 1, "high": 1},
            {"summary": {"critical": 1, "high": 1}},
            63,
            "HIGH",
        ),
        ({"critical": 9}, None, 100, "HIGH"),
    ],
)
def test_risk_score(gen, summary, compliance, score, level):
    assert gen._calculate_risk_score({"summary": summary}, compliance) == {
        "score": score,
        "level": level,
    }


def test_json_report_carries_the_scans_and_the_risk(gen, tmp_path):
    out = tmp_path / "r.json"
    text = gen.generate_json_report(_scan(CRITICAL), COMPLIANCE, out)

    report = json.loads(out.read_text(encoding="utf-8"))
    assert report == json.loads(text)
    assert report["report_type"] == "security_scan"
    assert report["compliance_analysis"] == COMPLIANCE
    assert report["risk_assessment"] == {"score": 53, "level": "HIGH"}
    assert "compliance_analysis" not in json.loads(gen.generate_json_report(_scan()))


def test_markdown_report_of_a_blocking_scan(gen, tmp_path):
    out = tmp_path / "r.md"
    md = gen.generate_markdown_report(
        _scan(CRITICAL, HIGH, DEPENDENCY), COMPLIANCE, out
    )

    assert out.read_text(encoding="utf-8") == md
    assert "**Project:** /work/app" in md
    assert "⛔ **STATUS: BLOCKING**" in md
    assert "### 1. Hardcoded secret: AWS Access Key" in md
    assert "**Location:** `config.py:3`" in md
    assert "- https://owasp.org/secrets" in md
    assert "**Location:** `run.py`" in md
    assert "**Scans Run:** secrets, bandit" in md
    assert "**Duration:** 1.50s" in md
    assert "❌ **Compliance Status: NON-COMPLIANT**" in md
    assert "1. **SOC2 - SOC2-CC6.1:** Hardcoded password" in md
    assert "   - Remediation: Use a vault" in md
    # The recommendations follow what was found.
    assert "**URGENT:**" in md
    assert "Remove all hardcoded secrets" in md
    assert "Update vulnerable dependencies" in md
    assert "Address compliance violations" in md


def test_markdown_report_of_a_warning_and_of_a_clean_scan(gen):
    warning = gen.generate_markdown_report(_scan(DEPENDENCY))
    assert "⚠️ **STATUS: WARNING**" in warning
    assert "Critical Vulnerabilities" not in warning

    clean = gen.generate_markdown_report(
        _scan(), {"frameworks": [], "summary": {"is_compliant": True}}
    )
    assert "✅ **STATUS: PASSED**" in clean
    assert "✅ **Compliance Status: COMPLIANT**" in clean
    assert "1. Continue monitoring for new vulnerabilities" in clean


def test_html_report_escapes_what_the_scanned_code_wrote(gen, tmp_path):
    """A finding's text comes from the scanned project: in the report it is
    text, never markup."""
    hostile = {
        **CRITICAL,
        "title": "<script>alert(1)</script>",
        "description": '<img src=x onerror="steal()">',
        "file": "<b>a.py",
        "remediation": "</p><iframe>",
    }
    out = tmp_path / "r.html"
    page = gen.generate_html_report(
        _scan(hostile, project_path="/work/<app>"), COMPLIANCE, out
    )

    assert out.read_text(encoding="utf-8") == page
    assert "<script>alert" not in page
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in page
    assert "<img" not in page and "<iframe>" not in page
    assert "📍 &lt;b&gt;a.py:3" in page
    assert "Project: /work/&lt;app&gt;" in page
    assert "BLOCKING" in page
    assert "<strong>URGENT:</strong> Fix all critical" in page


def test_html_report_status_without_criticals(gen):
    assert "WARNING - Review required" in gen.generate_html_report(_scan(HIGH))
    page = gen.generate_html_report(_scan())
    assert "PASSED - No critical issues" in page
    assert "Critical Vulnerabilities" not in page


def test_sarif_report_maps_levels_and_locations(gen, tmp_path):
    out = tmp_path / "r.sarif"
    gen.generate_sarif_report(
        _scan(CRITICAL, DEPENDENCY, {"severity": "info", "description": "note"}), out
    )

    sarif = json.loads(out.read_text(encoding="utf-8"))
    assert sarif["version"] == "2.1.0"
    secret, dep, info = sarif["runs"][0]["results"]
    assert (secret["ruleId"], secret["level"]) == ("SECRET-1a2b3c4d", "error")
    location = secret["locations"][0]["physicalLocation"]
    assert location == {
        "artifactLocation": {"uri": "config.py"},
        "region": {"startLine": 3},
    }
    assert (dep["level"], dep["message"]["text"], "locations" in dep) == (
        "warning",
        "Vulnerable dependency: minimist",
        False,
    )
    assert (info["ruleId"], info["level"]) == ("unknown", "note")


@pytest.mark.parametrize(
    ("scan", "status"),
    [(_scan(CRITICAL), "BLOCKING"), (_scan(HIGH), "WARNING"), (_scan(), "PASSED")],
)
def test_console_summary_with_rich(gen, capsys, scan, status):
    from rich.console import Console

    gen.console = Console(file=sys.stdout, width=100, force_terminal=False)
    gen.print_console_summary(scan)

    out = capsys.readouterr().out
    assert "Vulnerability Summary" in out
    assert status in out


@pytest.mark.parametrize(
    ("scan", "status"),
    [(_scan(CRITICAL), "BLOCKING"), (_scan(HIGH), "WARNING"), (_scan(), "PASSED")],
)
def test_console_summary_falls_back_to_plain_text(gen, capsys, scan, status):
    gen.console = None
    gen.print_console_summary(scan)

    out = capsys.readouterr().out
    assert f"STATUS: {status}" in out
    assert "Critical: " + str(scan["summary"]["critical"]) in out


def test_without_rich_the_generator_prints_plain_text(monkeypatch, capsys):
    real_import = builtins.__import__

    def no_rich(name, *args, **kwargs):
        if name.startswith("rich"):
            raise ImportError(name)
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", no_rich)
    try:
        module = importlib.reload(srg)
        generator = module.SecurityReportGenerator()
        assert generator.console is None
        generator.print_console_summary(_scan())
        assert "STATUS: PASSED" in capsys.readouterr().out
    finally:
        monkeypatch.setattr(builtins, "__import__", real_import)
        importlib.reload(srg)


def test_a_high_finding_names_its_line(gen):
    md = gen.generate_markdown_report(_scan({**HIGH, "line": 7}))
    assert "**Location:** `run.py:7`" in md
