"""SecurityOrchestrator: a scan, its reports, its verdict, and the manual CLI.

The scanners are the real ones, over a project written in the test; the
external tools are absent (their probe raises `FileNotFoundError`), so what is
found comes from the secrets scan and the compliance analysis.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from security import security_orchestrator as so
from security import vulnerability_scanner as vs
from security.compliance_analyzer import ComplianceFramework
from security.security_orchestrator import (
    SecurityOrchestrator,
    SecurityScanConfig,
    SecurityScanResult,
)

FAKE_AWS_KEY = "AKIA" + "Q7ZXR4MW2PLK9VBN"


@pytest.fixture(autouse=True)
def _no_external_tools(monkeypatch):
    real_run = subprocess.run

    def run(cmd, *args, **kwargs):
        if cmd[0] in ("git", sys.executable):
            return real_run(cmd, *args, **kwargs)
        raise FileNotFoundError(cmd[0])

    monkeypatch.setattr(vs.subprocess, "run", run)


@pytest.fixture
def project(temp_git_repo):
    (temp_git_repo / "keys.py").write_text(
        f'AWS_ACCESS_KEY_ID = "{FAKE_AWS_KEY}"\n', encoding="utf-8"
    )
    (temp_git_repo / "app.py").write_text("result = eval(data)\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=temp_git_repo, check=True)
    return temp_git_repo


def test_full_scan_writes_every_report_and_blocks_on_the_secret(
    project, tmp_path, capsys
):
    out = tmp_path / "reports" / "nested"
    orchestrator = SecurityOrchestrator(project, SecurityScanConfig(output_dir=out))

    result = orchestrator.run_full_scan()

    assert set(result.reports_generated) == {"json", "markdown", "html", "sarif"}
    assert all(path.is_file() for path in result.reports_generated.values())
    assert result.reports_generated["sarif"] == out / "security-scan.sarif"
    assert result.should_block is True
    summary = result.summary
    assert summary["vulnerabilities"]["critical"] == 1
    assert summary["compliance"]["critical"] >= 1
    assert summary["should_block"] is True
    assert "Reports saved to:" in capsys.readouterr().out


def test_reports_land_in_the_project_by_default(project):
    orchestrator = SecurityOrchestrator(
        str(project),
        SecurityScanConfig(
            compliance_frameworks=[],
            generate_markdown=False,
            generate_html=False,
            generate_sarif=False,
        ),
    )
    result = orchestrator.run_full_scan()

    assert orchestrator.output_dir == project / ".security-reports"
    assert list(result.reports_generated) == ["json"]
    assert result.compliance_report is None


def test_compliance_blocks_only_when_the_config_says_so(temp_git_repo):
    (temp_git_repo / "app.py").write_text("result = eval(data)\n", encoding="utf-8")
    frameworks = [ComplianceFramework.SOC2]

    lenient = SecurityOrchestrator(
        temp_git_repo, SecurityScanConfig(compliance_frameworks=frameworks)
    ).run_full_scan()
    strict = SecurityOrchestrator(
        temp_git_repo,
        SecurityScanConfig(
            compliance_frameworks=frameworks, block_on_compliance_critical=True
        ),
    ).run_full_scan()

    assert lenient.compliance_report["summary"]["is_compliant"] is False
    assert (lenient.should_block, strict.should_block) == (False, True)


def test_a_result_built_by_hand_blocks_on_non_compliance():
    result = SecurityScanResult(
        vulnerability_scan={}, compliance_report={"summary": {"is_compliant": False}}
    )
    assert result.should_block is True
    assert SecurityScanResult(vulnerability_scan={}).summary["compliance"] == {
        "critical": 0,
        "high": 0,
        "total": 0,
        "is_compliant": True,
    }


def test_quick_scan_writes_one_json_report(project, tmp_path):
    orchestrator = SecurityOrchestrator(
        project, SecurityScanConfig(output_dir=tmp_path / "out")
    )

    result = orchestrator.run_quick_scan()

    [path] = result.reports_generated.values()
    assert path.name.startswith("security-scan-quick-")
    assert (
        json.loads(path.read_text(encoding="utf-8"))["vulnerability_scan"]["summary"][
            "critical"
        ]
        == 1
    )
    no_report = SecurityOrchestrator(
        project, SecurityScanConfig(output_dir=tmp_path / "out", generate_json=False)
    ).run_quick_scan()
    assert no_report.reports_generated == {}


def test_a_commit_is_judged_on_the_files_it_changes(project, tmp_path, capsys):
    orchestrator = SecurityOrchestrator(
        project, SecurityScanConfig(output_dir=tmp_path / "out")
    )

    touching = orchestrator.scan_commit(["keys.py", "app.py"])
    elsewhere = orchestrator.scan_commit(["app.py"])

    assert touching.should_block is True
    assert touching.vulnerability_scan["summary"]["critical"] == 1
    assert "Security issues found in changed files" in capsys.readouterr().out
    # The secret is in a file this commit leaves alone.
    assert elsewhere.vulnerability_scan["vulnerabilities"] == []
    assert elsewhere.vulnerability_scan["should_block"] is False
    assert elsewhere.vulnerability_scan["should_warn"] is False
    assert elsewhere.should_block is False


def test_github_report_is_a_sarif_file(project, tmp_path):
    path = SecurityOrchestrator(
        project, SecurityScanConfig(output_dir=tmp_path / "out")
    ).generate_github_security_report()

    assert path == tmp_path / "out" / "security-scan.sarif"
    [finding] = json.loads(path.read_text(encoding="utf-8"))["runs"][0]["results"]
    assert (
        finding["locations"][0]["physicalLocation"]["artifactLocation"]["uri"]
        == "keys.py"
    )


def test_policy_names_the_critical_findings_first(project, tmp_path):
    verdict = SecurityOrchestrator(
        project, SecurityScanConfig(output_dir=tmp_path / "out")
    ).check_policy_compliance()
    assert verdict == (False, "Found 1 critical vulnerabilities")


def test_policy_counts_secrets_when_criticals_do_not_block(project, tmp_path):
    verdict = SecurityOrchestrator(
        project,
        SecurityScanConfig(output_dir=tmp_path / "out", block_on_critical=False),
    ).check_policy_compliance()
    assert verdict == (False, "Found 1 hardcoded secrets")


def test_policy_on_compliance_then_a_clean_project(temp_git_repo, tmp_path):
    (temp_git_repo / "app.py").write_text("result = eval(data)\n", encoding="utf-8")
    strict = SecurityScanConfig(
        output_dir=tmp_path / "out",
        compliance_frameworks=[ComplianceFramework.SOC2],
        block_on_compliance_critical=True,
    )
    assert SecurityOrchestrator(temp_git_repo, strict).check_policy_compliance() == (
        False,
        "Critical compliance violations found",
    )

    (temp_git_repo / "app.py").write_text("result = 1\n", encoding="utf-8")
    assert SecurityOrchestrator(
        temp_git_repo,
        SecurityScanConfig(output_dir=tmp_path / "out", compliance_frameworks=[]),
    ).check_policy_compliance() == (True, "Security policy compliance verified")


def _main(monkeypatch, *argv: str) -> int:
    monkeypatch.setattr(sys, "argv", ["security_orchestrator", *argv])
    with pytest.raises(SystemExit) as exit_info:
        so.main()
    return exit_info.value.code


def test_cli_fails_a_project_with_a_secret(project, tmp_path, monkeypatch, capsys):
    code = _main(
        monkeypatch,
        "--project-path",
        str(project),
        "--output-dir",
        str(tmp_path / "out"),
        "--format",
        "markdown",
        "--compliance",
        "gdpr",
        "pci-dss",
    )

    assert code == 1
    assert "Security scan FAILED" in capsys.readouterr().out
    assert [p.suffix for p in (tmp_path / "out").iterdir()] == [".md"]


def test_cli_report_only_and_quick(project, tmp_path, monkeypatch, capsys):
    assert (
        _main(
            monkeypatch,
            "--project-path",
            str(project),
            "--output-dir",
            str(tmp_path / "out"),
            "--no-block",
            "--compliance",
            "all",
        )
        == 0
    )
    assert "Security scan PASSED" in capsys.readouterr().out

    assert (
        _main(
            monkeypatch,
            "--project-path",
            str(project),
            "--output-dir",
            str(tmp_path / "out"),
            "--quick",
        )
        == 1
    )


def test_the_module_runs_as_a_script():
    import os

    backend = Path(so.__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "security.security_orchestrator", "--help"],
        cwd=backend,
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONUTF8": "1"},
    )
    assert result.returncode == 0
    assert "--compliance" in result.stdout
