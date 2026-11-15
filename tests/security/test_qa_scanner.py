"""The QA security scan: patterns over the task's files, the verdict, the report.

The project lives where a task's worktree does, under
`.workpilot/worktrees/tasks/`: the scan must see its files.
"""

from __future__ import annotations

import pytest
from security import qa_scanner
from security.qa_scanner import (
    QASecurityScanner,
    SecurityScanSummary,
    run_qa_security_scan,
)
from security.vulnerability_scanner import (
    ScanResult,
    Severity,
    Vulnerability,
    VulnerabilitySource,
)


@pytest.fixture
def worktree(tmp_path):
    root = tmp_path / "repo" / ".workpilot" / "worktrees" / "tasks" / "001-login"
    root.mkdir(parents=True)
    return root


def _write(root, rel, text):
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_patterns_are_found_in_a_task_worktree(worktree):
    _write(worktree, "api/db.py", 'cursor.execute(f"SELECT * FROM t WHERE id={uid}")\n')
    _write(worktree, "web/view.tsx", "el.innerHTML = html\n// el.innerHTML = old\n")
    _write(worktree, ".env", 'API_KEY = "abcdefgh12345678"\n')
    _write(worktree, ".env.local", 'token = "abcdefgh12345678"\n')
    _write(worktree, "node_modules/lib/index.js", "document.write(x)\n")
    _write(worktree, "build/out.py", "eval(x)\n")
    _write(worktree, "README.rst", "eval(x)\n")

    summary = QASecurityScanner(worktree).scan(include_tool_scans=False)

    found = {(v.id, v.file, v.line) for v in summary.pattern_findings}
    assert found == {
        ("SQL-001", "api/db.py", 1),
        ("SQL-002", "api/db.py", 1),
        ("XSS-001", "web/view.tsx", 1),
        ("SECRET-001", ".env", 1),
        ("SECRET-001", ".env.local", 1),
    }
    assert summary.scan_result.scans_run == ["pattern-scan"]
    assert (summary.passed, summary.blocking) == (False, True)
    assert (summary.critical_count, summary.high_count) == (3, 2)


def test_a_project_under_a_folder_named_like_a_skipped_one_is_scanned(tmp_path):
    root = tmp_path / "build" / "app"
    _write(root, "main.py", "subprocess.run(cmd, shell=True)\n")

    [finding] = QASecurityScanner(root).scan(include_tool_scans=False).pattern_findings

    assert (finding.id, finding.severity, finding.cwe) == (
        "CMD-001",
        Severity.HIGH,
        "CWE-78",
    )


def test_an_unreadable_file_is_skipped(worktree, monkeypatch):
    _write(worktree, "a.py", "eval(x)\n")
    _write(worktree, "b.py", "eval(y)\n")
    real_read = qa_scanner.Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "a.py":
            raise PermissionError(self)
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(qa_scanner.Path, "read_text", read_text)

    findings = (
        QASecurityScanner(worktree).scan(include_tool_scans=False).pattern_findings
    )

    assert [v.file for v in findings] == ["b.py"]


def test_tool_scans_feed_the_same_summary(worktree, monkeypatch):
    seen = {}

    def scan_all(self, **kinds):
        seen.update(kinds)
        result = ScanResult(project_path=self.project_path, scans_run=["bandit"])
        result.vulnerabilities.append(
            Vulnerability("B1", Severity.MEDIUM, VulnerabilitySource.BANDIT, "t", "d")
        )
        return result

    monkeypatch.setattr(qa_scanner.VulnerabilityScanner, "scan_all", scan_all)

    summary = QASecurityScanner(worktree).scan(include_pattern_scans=False)

    assert seen == {
        "include_secrets": True,
        "include_sast": True,
        "include_dependencies": True,
        "include_containers": False,
    }
    assert summary.scan_result.scans_run == ["bandit"]
    assert (summary.passed, summary.blocking) == (True, False)


def _vuln(severity, **extra):
    return Vulnerability(
        extra.pop("id", "X-1"),
        severity,
        VulnerabilitySource.CUSTOM,
        extra.pop("title", "Title"),
        "Description",
        **extra,
    )


def test_markdown_of_a_clean_scan(tmp_path):
    clean = SecurityScanSummary(scan_result=ScanResult(project_path=tmp_path))
    assert "✅ **No security issues detected.**" in clean.to_markdown()
    assert "Scans run: pattern-scan" in clean.to_markdown()


def test_markdown_groups_findings_by_severity_and_lists_errors(tmp_path):
    result = ScanResult(
        project_path=tmp_path, scans_run=["bandit"], scan_errors=["npm audit timed out"]
    )
    summary = SecurityScanSummary(
        scan_result=result,
        pattern_findings=[
            _vuln(
                Severity.CRITICAL,
                file="a.py",
                line=3,
                cwe="CWE-89",
                remediation="Bind it",
            ),
            _vuln(Severity.HIGH, file="b.py"),
            _vuln(Severity.MEDIUM),
            _vuln(Severity.LOW),
        ],
        passed=False,
        blocking=True,
        duration_seconds=2.25,
    )

    md = summary.to_markdown()

    assert "🚨 **Security Summary:** Critical: 1 | High: 1 | Medium: 1 | Low: 1" in md
    assert "**BUILD BLOCKED**" in md
    assert "Scans run: bandit, pattern-scan" in md
    assert "Scan duration: 2.2s" in md or "Scan duration: 2.3s" in md
    assert "### CRITICAL (1)" in md and "### LOW (1)" in md
    assert "  - Location: `a.py:3`" in md
    assert "  - Location: `b.py`" in md
    assert "  - CWE: CWE-89" in md
    assert "  - 💡 Fix: Bind it" in md
    assert "### Scan Errors\n\n- npm audit timed out" in md


def test_markdown_of_a_high_only_scan_warns(tmp_path):
    summary = SecurityScanSummary(
        scan_result=ScanResult(project_path=tmp_path),
        pattern_findings=[_vuln(Severity.HIGH)],
        passed=False,
    )
    md = summary.to_markdown()
    assert md.count("⚠️") == 2
    assert "High-severity issues found" in md

    info = SecurityScanSummary(
        scan_result=ScanResult(project_path=tmp_path),
        pattern_findings=[_vuln(Severity.LOW)],
    )
    assert "ℹ️ **Security Summary:**" in info.to_markdown()


def test_only_high_and_critical_become_qa_issues(tmp_path):
    summary = SecurityScanSummary(
        scan_result=ScanResult(project_path=tmp_path),
        pattern_findings=[
            _vuln(Severity.CRITICAL, title="SQL", file="a.py", line=2, cwe="CWE-89"),
            _vuln(Severity.HIGH, file="b.py", remediation="Escape it"),
            _vuln(Severity.HIGH),
            _vuln(Severity.MEDIUM, file="c.py"),
        ],
    )

    assert summary.to_qa_issues() == [
        {
            "type": "critical",
            "title": "Security: SQL",
            "location": "a.py:2",
            "fix_required": "Fix this security vulnerability",
            "source": "custom",
            "cwe": "CWE-89",
        },
        {
            "type": "high",
            "title": "Security: Title",
            "location": "b.py",
            "fix_required": "Escape it",
            "source": "custom",
            "cwe": None,
        },
        {
            "type": "high",
            "title": "Security: Title",
            "location": "",
            "fix_required": "Fix this security vulnerability",
            "source": "custom",
            "cwe": None,
        },
    ]


@pytest.fixture
def no_tools(monkeypatch):
    def scan_all(self, **_kinds):
        return ScanResult(project_path=self.project_path)

    monkeypatch.setattr(qa_scanner.VulnerabilityScanner, "scan_all", scan_all)


async def test_the_qa_report_gets_one_security_section(worktree, tmp_path, no_tools):
    spec = tmp_path / "spec"
    spec.mkdir()
    report = spec / "qa_report.md"
    report.write_text("# QA\n\nAll green.\n", encoding="utf-8")
    _write(worktree, "a.py", "eval(x)\n")

    passed, section, issues = await run_qa_security_scan(worktree, spec)
    await run_qa_security_scan(worktree, spec)

    text = report.read_text(encoding="utf-8")
    assert passed is False
    assert text.startswith("# QA\n\nAll green.\n")
    assert text.count("## 🔐 Security Scan Results") == 1
    assert text.endswith(section)
    assert [i["title"] for i in issues] == [
        "Security: Potential command injection via exec/eval"
    ]


async def test_a_missing_report_is_created_and_an_unwritable_one_ignored(
    worktree, tmp_path, no_tools
):
    spec = tmp_path / "spec"
    spec.mkdir()

    passed, section, issues = await run_qa_security_scan(worktree, spec)

    assert (passed, issues) == (True, [])
    assert (spec / "qa_report.md").read_text(encoding="utf-8") == section

    gone = tmp_path / "missing-spec"
    assert (await run_qa_security_scan(worktree, gone))[0] is True
    assert not gone.exists()
