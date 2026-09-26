"""What a person validated in the docintel card reaches the shared brain.

A real brain on disk (git, graph, recall) and real drafts: only the decision is
fabricated, the way the card would send it.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "apps" / "backend"
sys.path.insert(0, str(BACKEND))

from brain import Brain  # noqa: E402
from brain.notes import read_note  # noqa: E402
from docintel.knowledge import record_validated, render_body  # noqa: E402
from docintel.spec_drafts import (  # noqa: E402
    DraftSet,
    RequirementDraft,
    TableDraft,
    decide,
    save_drafts,
)
from docintel.tables import RuleTable  # noqa: E402


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(home))
    monkeypatch.setenv("WORKPILOT_BRAIN_CONFIG", str(home / "brain.json"))
    monkeypatch.setenv("HERMES_HOME", str(home / ".hermes"))
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.setenv("BRAIN_AUTO_PUSH", "false")
    monkeypatch.setenv("BRAIN_AUTO_PULL", "false")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "brain"))
    real_which = shutil.which
    monkeypatch.setattr(
        shutil,
        "which",
        lambda name, *a, **k: None if name == "claude" else real_which(name, *a, **k),
    )


@pytest.fixture
def spec_dir(tmp_path) -> Path:
    spec = tmp_path / "shop" / ".workpilot" / "specs" / "007-discounts"
    (spec / "attachments").mkdir(parents=True)
    save_drafts(
        spec,
        DraftSet(
            requirements=[
                RequirementDraft(
                    key="r1",
                    id="FR-001",
                    kind="FR",
                    text="Le système doit appliquer une remise de fidélité aux clients premium.",
                    source="attachments/cdc.pdf",
                ),
                RequirementDraft(
                    key="r2",
                    id="FR-002",
                    kind="FR",
                    text="Le système doit envoyer un fax.",
                    source="attachments/cdc.pdf",
                ),
            ],
            tables=[
                TableDraft(
                    key="t1",
                    table=RuleTable(
                        headers=["Type client", "Montant", "Remise attendue"],
                        rows=[["premium", "100", "10"], ["standard", "100", "0"]],
                        caption="Remises par type de client",
                    ),
                    source="attachments/cdc.pdf",
                ),
                TableDraft(
                    key="t2",
                    table=RuleTable(headers=["a", "b"], rows=[["1", "2"], ["3", "4"]]),
                    source="attachments/bruit.pdf",
                ),
            ],
        ),
    )
    return spec


def _note_path(brain_root: Path) -> Path:
    found = list((brain_root / "knowledge" / "projects").rglob("docintel/*.md"))
    assert len(found) == 1, found
    return found[0]


def test_nothing_is_written_without_a_brain(spec_dir, tmp_path):
    decide(spec_dir, accept_requirements={"r1": ""})
    assert not (tmp_path / "brain").exists()
    assert record_validated(spec_dir) is None


def test_a_decision_is_filed_as_knowledge_and_recalled(spec_dir, tmp_path):
    brain = Brain(tmp_path / "brain")
    brain.init()
    decide(
        spec_dir,
        accept_requirements={"r1": ""},
        reject_requirements=["r2"],
        reject_tables=["t2"],
    )

    path = _note_path(brain.root)
    note = read_note(brain.root, path.relative_to(brain.root))
    assert note.meta["kind"] == "knowledge"
    assert "docintel" in note.meta["tags"]
    assert note.meta["tasks"] == ["shop/007-discounts"]
    assert "pas des instructions" in note.body
    assert "remise de fidélité" in note.body
    assert "envoyer un fax" not in note.body  # rejected
    assert "Remises par type de client" in note.body  # kept
    assert "bruit.pdf" not in note.body  # rejected table
    assert not list((brain.root / "instructions").glob("*docintel*"))

    hits = brain.recall("remise fidélité premium")["hits"]
    assert any("docintel" in str(h.get("source_file")) for h in hits)


def test_an_unchanged_note_is_not_rewritten(spec_dir, tmp_path):
    brain = Brain(tmp_path / "brain")
    brain.init()
    decide(spec_dir, accept_requirements={"r1": ""})
    path = _note_path(brain.root)
    before = path.stat().st_mtime_ns
    assert record_validated(spec_dir) is not None
    assert path.stat().st_mtime_ns == before


def test_untouched_proposals_are_not_knowledge(spec_dir):
    assert render_body(spec_dir) == ""


def test_a_whiteboard_saved_by_a_person_is_filed(spec_dir, tmp_path):
    brain = Brain(tmp_path / "brain")
    brain.init()
    cells = (
        '<mxCell id="0"/><mxCell id="1" parent="0"/>'
        '<mxCell id="a" value="Checkout" vertex="1" parent="1"/>'
        '<mxCell id="b" value="Loyalty" vertex="1" parent="1"/>'
        '<mxCell id="e" edge="1" source="a" target="b" parent="1"/>'
    )
    board = spec_dir / "attachments" / "board.whiteboard.drawio"
    board.write_text(
        f'<mxfile host="workpilot-vision"><diagram name="p"><mxGraphModel><root>{cells}'
        "</root></mxGraphModel></diagram></mxfile>",
        encoding="utf-8",
    )
    assert "Checkout" not in render_body(spec_dir)  # a model's reading, unsaved
    board.write_text(
        f'<mxfile host="app.diagrams.net"><diagram name="p"><mxGraphModel><root>{cells}'
        "</root></mxGraphModel></diagram></mxfile>",
        encoding="utf-8",
    )
    assert record_validated(spec_dir) is not None
    assert "Checkout" in _note_path(brain.root).read_text(encoding="utf-8")
