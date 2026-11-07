"""Audit findings from F113 on live one per file (docs/audit/findings/).

The atlas loads their generated cards by probing F113.js, F114.js… so the
cards must be current, every number must be reachable, and no finding may
also stay inline in the atlas.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
AUDIT = ROOT / "docs" / "audit"
ATLAS = AUDIT / "WorkPilot-architecture.html"
CAHIER = AUDIT / "AUDIT-NETTOYAGE.md"

_spec = importlib.util.spec_from_file_location(
    "audit_findings", ROOT / "scripts" / "audit_findings.py"
)
audit_findings = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(audit_findings)


def _file_ids() -> list[int]:
    return sorted(
        int(m.group(1))
        for p in audit_findings.FINDINGS_DIR.glob("F*.md")
        if (m := audit_findings.FILE_NAME.match(p.name))
    )


def test_generated_cards_are_current():
    assert audit_findings.problems() == []


def test_the_atlas_reaches_every_finding_file():
    ids = _file_ids()
    assert ids, "no finding file"
    assert ids[0] == audit_findings.FIRST_FILE_ID
    # The atlas stops after three missing numbers in a row.
    gaps = [(a, b) for a, b in zip(ids, ids[1:]) if b - a > 3]
    assert gaps == []


def test_the_atlas_loads_the_files_and_keeps_none_inline():
    html = ATLAS.read_text(encoding="utf-8")
    assert f"loadFindingFiles({audit_findings.FIRST_FILE_ID}).then(init)" in html
    inline = {int(n) for n in re.findall(r'\{id:"F(\d+)"', html)}
    assert not inline & set(_file_ids())
    assert all(n < audit_findings.FIRST_FILE_ID for n in inline)


def test_the_cahier_keeps_no_section_for_a_finding_file():
    text = CAHIER.read_text(encoding="utf-8")
    inline = {int(n) for n in re.findall(r"(?m)^#### F(\d+) · ", text)}
    assert not inline & set(_file_ids())


def test_every_annex_link_of_the_cahier_resolves():
    text = CAHIER.read_text(encoding="utf-8")
    links = re.findall(r"\]\((annexes/[^)#]+)\)", text)
    assert links
    for link in links:
        assert (AUDIT / link).is_file(), link


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda t: t.replace("severity: moy", "severity: medium"), "severity"),
        (lambda t: t.replace("id: F200", "id: F201"), "id is"),
        (lambda t: t.replace("# F200 · Titre", "# F200 · Autre"), "body starts"),
        (lambda t: t.replace("  gain: g\n", ""), "card has"),
    ],
)
def test_an_invalid_header_is_refused(tmp_path, change, message):
    good = (
        "---\nid: F200\ntitle: Titre\nseverity: moy\nstatus: résolu\n"
        "category: ci\nverified: vérifié\ncard:\n  finding: f\n  evidence: e\n"
        "  recommendation: r\n  gain: g\n  preserve: p\n---\n\n# F200 · Titre\n\nCorps.\n"
    )
    path = tmp_path / "F200.md"
    path.write_text(good, encoding="utf-8")
    assert audit_findings.card(path)["t"] == "Titre"
    path.write_text(change(good), encoding="utf-8")
    with pytest.raises(audit_findings.FindingError, match=message):
        audit_findings.card(path)


def test_a_stale_or_orphan_card_is_reported(tmp_path):
    md = tmp_path / "F200.md"
    md.write_text(
        "---\nid: F200\ntitle: T\nseverity: moy\nstatus: résolu\ncategory: ci\n"
        "verified: vérifié\ncard:\n  finding: f\n  evidence: e\n  recommendation: r\n"
        "  gain: g\n  preserve: p\n---\n\n# F200 · T\n",
        encoding="utf-8",
    )
    assert audit_findings.problems(tmp_path) == ["F200.js is missing"]
    (tmp_path / "F200.js").write_text("old", encoding="utf-8")
    (tmp_path / "F201.js").write_text("old", encoding="utf-8")
    assert audit_findings.problems(tmp_path) == [
        "F200.js is stale",
        "F201.js has no F201.md",
    ]
