"""The compliance frameworks: bundled, overridden and extended by the project (#357).

Every bundled control is worded in English and French and asks only for
evidence the collector finds; a project file replaces a bundled framework or
adds one, and a file that does not hold is skipped and named, never trusted
in part.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from compliance_collector.frameworks import (
    EVIDENCE_KINDS,
    load_frameworks,
    parse_framework,
)


def test_the_bundled_frameworks_are_complete_and_bilingual():
    frameworks, errors = load_frameworks()
    assert errors == []
    assert set(frameworks) == {"soc2", "iso27001", "hipaa", "pci_dss"}
    for framework in frameworks.values():
        assert framework.source == "bundled" and framework.version
        for control in framework.controls:
            assert set(control.title) == {"en", "fr"}, control.id
            assert set(control.recommendation) == {"en", "fr"}, control.id
            for group in control.requirements:
                assert set(group) <= set(EVIDENCE_KINDS)
    iso = [c.id for c in frameworks["iso27001"].controls]
    assert "A.8.8" in iso and "A.12.6" not in iso  # the 2022 numbering


def _write(root: Path, name: str, text: str) -> None:
    folder = root / ".workpilot" / "compliance" / "frameworks"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(text, encoding="utf-8")


def test_a_project_file_replaces_or_adds_and_a_bad_one_is_named(tmp_path: Path):
    _write(
        tmp_path,
        "soc2.yaml",
        "id: soc2\nname: SOC 2 (ours)\ncontrols:\n"
        "  - {id: CC8.1, title: Change, evidence: [change], max_age_days: 7}\n",
    )
    _write(
        tmp_path,
        "nist.yml",
        "id: nist-csf\nversion: 2.0\ncontrols:\n"
        "  - id: PR.PS-01\n    title: {en: Configuration, fr: Configuration}\n"
        "    evidence: [[change, merge]]\n",
    )
    _write(
        tmp_path,
        "broken.yaml",
        "id: x\ncontrols:\n  - {id: A, title: A, evidence: [telepathy]}\n",
    )
    _write(tmp_path, "not-yaml.yaml", "id: [unclosed\n")
    frameworks, errors = load_frameworks(tmp_path)
    assert frameworks["soc2"].name == "SOC 2 (ours)"
    assert [c.id for c in frameworks["soc2"].controls] == ["CC8.1"]
    assert frameworks["nist-csf"].version == "2.0"
    assert frameworks["nist-csf"].controls[0].max_age_days == 90
    assert "iso27001" in frameworks
    assert len(errors) == 2
    assert any("telepathy" in e for e in errors)


def test_a_linked_frameworks_folder_is_not_read(tmp_path: Path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "soc2.yaml").write_text(
        "id: soc2\ncontrols:\n  - {id: X, title: X, evidence: [change]}\n",
        encoding="utf-8",
    )
    project = tmp_path / "project"
    (project / ".workpilot" / "compliance").mkdir(parents=True)
    (project / ".workpilot" / "compliance" / "frameworks").symlink_to(elsewhere)
    frameworks, _ = load_frameworks(project)
    assert frameworks["soc2"].source == "bundled"


@pytest.mark.parametrize(
    "data",
    [
        {
            "id": "Bad Id",
            "controls": [{"id": "A", "title": "A", "evidence": ["change"]}],
        },
        {"id": "ok", "controls": []},
        {"id": "ok", "controls": [{"id": "A", "evidence": ["change"]}]},
        {"id": "ok", "controls": [{"id": "A", "title": "A", "evidence": []}]},
        {
            "id": "ok",
            "controls": [
                {"id": "A", "title": "A", "evidence": ["change"], "max_age_days": 0}
            ],
        },
        {
            "id": "ok",
            "controls": [
                {"id": "A", "title": "A", "evidence": ["change"]},
                {"id": "A", "title": "B", "evidence": ["merge"]},
            ],
        },
    ],
)
def test_a_framework_that_does_not_hold_is_refused(data):
    with pytest.raises(ValueError):
        parse_framework(data, "test")
