"""ComplianceAnalyzer: the rule each framework applies to the project's code."""

from __future__ import annotations

import pytest
from security import compliance_analyzer as ca
from security.compliance_analyzer import (
    ComplianceAnalyzer,
    ComplianceFramework,
    ComplianceSeverity,
)

F = ComplianceFramework


def _project(root, files: dict[str, str]):
    for rel, text in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    return root


def _rules(report):
    return sorted(
        (v.rule_id, v.severity.value, v.file, v.line) for v in report.violations
    )


def test_personal_data_needs_consent_and_encryption(tmp_path):
    root = _project(
        tmp_path,
        {
            "users/model.py": "email = form.get('email')\n",
            "users/consented.py": "# user consent recorded\nphone = encrypt(value)\n",
            "users/login.py": "password = request.password\n",
        },
    )

    report = ComplianceAnalyzer(root).analyze([F.GDPR])

    assert [r for r in _rules(report) if r[2] != "project-level"] == [
        ("GDPR-ART32", "medium", "users/model.py", 1),
        ("GDPR-ART6", "high", "users/model.py", 1),
    ]
    # No crypto module in the project: one project-level reminder.
    assert ("GDPR-ART32", "medium", "project-level", None) in _rules(report)
    assert report.files_scanned == 3


def test_ccpa_alone_checks_personal_data_too(tmp_path):
    root = _project(tmp_path, {"geo.ts": "const geolocation = navigator.geo\n"})
    report = ComplianceAnalyzer(root).analyze([F.CCPA])
    assert {v.rule_id for v in report.violations} == {"GDPR-ART6", "GDPR-ART32"}


def test_health_data_needs_encryption_and_access_control(tmp_path):
    root = _project(
        tmp_path,
        {
            "bare.py": "patient = load()\n",
            "guarded.py": "# rbac and aes applied\ndiagnosis = read()\n",
        },
    )

    report = ComplianceAnalyzer(root).analyze([F.HIPAA])

    assert _rules(report) == [
        ("HIPAA-164.308", "high", "bare.py", 1),
        ("HIPAA-164.312", "critical", "bare.py", 1),
    ]
    assert report.is_compliant is False


def test_card_data_rules(tmp_path):
    root = _project(
        tmp_path,
        {
            "pay.py": "cvv = card.cvv\n",
            "vaulted.py": "card_number = vault.tokenize(n)\n",
        },
    )

    report = ComplianceAnalyzer(root).analyze([F.PCI_DSS])

    assert _rules(report) == [
        ("PCI-DSS-3.2", "critical", "pay.py", 1),
        ("PCI-DSS-3.4", "critical", "pay.py", 1),
    ]


def test_security_controls_in_code_and_at_project_level(tmp_path):
    root = _project(
        tmp_path,
        {
            "src/conf.py": 'password = "hunter22"\n',
            "src/notes.js": "// TODO: fix security of eval(\n",
            "src/data.py": "yaml.load(stream)\nyaml.safe_load(stream)\n",
        },
    )

    report = ComplianceAnalyzer(root).analyze([F.SOC2])
    by_title = {v.title: v for v in report.violations}

    assert by_title[
        "Security control issue: Hardcoded password"
    ].remediation.startswith("Use environment variables")
    todo = by_title["Security control issue: Security TODO item"]
    assert (todo.severity, todo.remediation) == (
        ComplianceSeverity.MEDIUM,
        "Review and remediate this security issue",
    )
    assert by_title["Security control issue: Dangerous eval() usage"].severity is (
        ComplianceSeverity.MEDIUM
    )
    yaml_hits = [
        v for v in report.violations if v.title.endswith("Unsafe YAML loading")
    ]
    assert [v.line for v in yaml_hits] == [1]
    assert {"Missing audit logging", "Missing authentication module"} <= set(by_title)


def test_project_level_modules_silence_their_rule(tmp_path):
    root = _project(
        tmp_path,
        {"audit.py": "", "auth.py": "", "crypto.py": ""},
    )
    report = ComplianceAnalyzer(root).analyze()
    assert report.violations == []
    assert report.frameworks == list(ComplianceFramework)
    assert report.to_dict()["summary"] == {
        "critical": 0,
        "high": 0,
        "total": 0,
        "is_compliant": True,
    }


def test_iso_27001_alone_asks_for_authentication(tmp_path):
    report = ComplianceAnalyzer(tmp_path).analyze([F.ISO_27001])
    assert [v.title for v in report.violations] == ["Missing authentication module"]


def test_dependency_folders_inside_the_project_are_skipped(tmp_path):
    root = _project(
        tmp_path / "env" / "checkout",
        {
            "app.py": "exec(code)\n",
            "node_modules/lib/x.js": "eval(a)\n",
            "build/gen.py": "eval(b)\n",
            "README.md": "eval(c)\n",
        },
    )

    report = ComplianceAnalyzer(root).analyze([F.SOC2])

    files = {v.file for v in report.violations} - {"project-level"}
    assert files == {"app.py"}
    assert report.files_scanned == 1


def test_files_are_named_with_forward_slashes(tmp_path):
    root = _project(tmp_path, {"a/b/c.py": "patient = 1\n"})
    [first, *_] = ComplianceAnalyzer(root).analyze([F.HIPAA]).violations
    assert first.file == "a/b/c.py"


def test_an_unreadable_file_is_skipped(tmp_path, monkeypatch):
    root = _project(tmp_path, {"a.py": "patient = 1\n", "b.py": "patient = 2\n"})
    real_read = ca.Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name == "a.py":
            raise PermissionError(self)
        return real_read(self, *args, **kwargs)

    monkeypatch.setattr(ca.Path, "read_text", read_text)

    report = ComplianceAnalyzer(root).analyze([F.HIPAA])

    assert {v.file for v in report.violations} == {"b.py"}
    assert report.files_scanned == 2


def test_violation_and_report_serialise(tmp_path):
    root = _project(tmp_path, {"p.py": "patient = 1\n"})
    data = ComplianceAnalyzer(str(root)).analyze([F.HIPAA]).to_dict()

    assert data["frameworks"] == ["HIPAA"]
    assert data["files_scanned"] == 1
    assert data["summary"]["is_compliant"] is False
    critical = next(v for v in data["violations"] if v["severity"] == "critical")
    assert critical["framework"] == "HIPAA"
    assert critical["references"]
    assert "detected_at" in critical


@pytest.mark.parametrize("framework", list(ComplianceFramework))
def test_an_empty_project_is_analysed_for_every_framework(tmp_path, framework):
    report = ComplianceAnalyzer(tmp_path).analyze([framework])
    assert report.files_scanned == 0
