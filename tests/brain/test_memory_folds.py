"""Separating a learning-loop merge (#348): the folded pattern is kept.

* a merge keeps the pattern it folded in, with what it brought, and the
  journal's ``merge`` entry names it;
* within the hour the merge is the last automatic decision (**Undo**), then
  it is offered as **Separate** while the fold is kept;
* separating brings the folded pattern back as its own and takes its share
  out of the other: occurrences, its builds and tags, one confidence boost;
* a fold past its retention is purged and no longer offered; hostile kept
  paths are refused.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain import Brain
from brain.lifecycle import folds, journal, undo
from brain.lifecycle.journal import JournalEntry
from brain.notes import Note, read_note, write_note
from brain.project_memory import ProjectMemory

BASE = "knowledge/projects/shop/memory"
CANONICAL = f"{BASE}/patterns/run-migrations.md"
FOLDED_BACK = f"{BASE}/patterns/other.md"


@pytest.fixture
def brain(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.delenv("BRAIN_MEMORY_RETENTION_DAYS", raising=False)
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    b = Brain(root)
    b.init()
    return b


def _pattern(**over):
    from learning_loop.models import LearningPattern

    data = {
        "pattern_id": "run-migrations",
        "category": "qa_pattern",
        "pattern_type": "failure",
        "source": "qa_feedback",
        "description": "Run migrations before tests",
        "confidence": 0.6,
        "occurrence_count": 2,
        "context_tags": ["db"],
        "actionable_instruction": "Run the migrations before running the tests.",
        "source_build_ids": ["b1"],
        "agent_phase": "coding",
    }
    data.update(over)
    return LearningPattern(**data)


def _merged(brain):
    from learning_loop.pattern_storage import PatternStorage

    storage = PatternStorage(project="shop")
    storage.add_patterns([_pattern()])
    storage.add_patterns(
        [
            _pattern(
                pattern_id="other",
                occurrence_count=3,
                context_tags=["db", "ci"],
                source_build_ids=["b1", "b2"],
                actionable_instruction="Run the migrations before running tests.",
            )
        ]
    )
    (merge,) = [e for e in journal.read(brain.root, BASE) if e.action == "merge"]
    return storage, merge


def _evidence(root: Path, rel: str) -> dict:
    return read_note(root, rel).meta["learning"]


def test_a_merge_keeps_the_folded_pattern_and_names_it(brain):
    _, merge = _merged(brain)
    (kept,) = folds.kept(brain.root, BASE, merge)
    assert kept.startswith(f"{BASE}/.lifecycle/folded/patterns/other--")
    assert kept in merge.related
    note = read_note(brain.root, kept)
    assert note.meta["learning"]["pattern_id"] == "other"
    info = note.meta["lifecycle"]
    assert info["canonical"] == CANONICAL and info["was"] == FOLDED_BACK
    assert info["share"] == {
        "occurrences": 3,
        "builds": ["b2"],
        "tags": ["ci"],
        "boost": 0.15,
    }
    merged = _evidence(brain.root, CANONICAL)
    assert merged["occurrence_count"] == 5
    assert merged["confidence"] == pytest.approx(0.66)
    # Kept in a dot folder: no recall, no learning loop reads it as a pattern.
    ids = [p["pattern_id"] for p in ProjectMemory(project="shop").learned_patterns()]
    assert ids == ["run-migrations"]


def test_separating_brings_the_pattern_back_and_takes_its_share_out(brain):
    storage, merge = _merged(brain)
    modes = undo.revertible(brain.root, BASE, journal.read(brain.root, BASE))
    assert modes[merge.id] == "undo"
    later = datetime.now(UTC) + timedelta(days=2)
    assert undo.revertible(brain.root, BASE, [merge], now=later) == {
        merge.id: "unmerge"
    }

    outcome = undo.revert(brain.root, BASE, merge.id, now=later)
    assert outcome == {
        "ok": True,
        "restored": [FOLDED_BACK],
        "conflict": None,
        "mode": "unmerge",
    }
    back = _evidence(brain.root, FOLDED_BACK)
    assert back["occurrence_count"] == 3 and back["source_build_ids"] == ["b1", "b2"]
    canonical = _evidence(brain.root, CANONICAL)
    assert canonical["occurrence_count"] == 2
    assert canonical["confidence"] == pytest.approx(0.6)
    assert canonical["source_build_ids"] == ["b1"]
    assert canonical["context_tags"] == ["db"]
    body = read_note(brain.root, CANONICAL).body
    assert "confidence 0.60, seen 2×" in body
    assert sorted(p.pattern_id for p in storage.load_patterns()) == [
        "other",
        "run-migrations",
    ]

    entries = journal.read(brain.root, BASE)
    assert entries[0].action == "restore" and entries[0].undoes == merge.id
    assert entries[0].reason_code == "unmerged"
    assert undo.revert(brain.root, BASE, merge.id)["code"] == "not-revertible"


def test_a_fold_past_its_retention_is_purged_and_no_longer_offered(brain):
    _, merge = _merged(brain)
    later = datetime.now(UTC) + timedelta(days=31)
    assert undo.revertible(brain.root, BASE, [merge], now=later) == {}
    assert folds.purge_expired(brain.root, BASE) == 0
    assert folds.purge_expired(brain.root, BASE, now=later) == 1
    assert folds.kept(brain.root, BASE, merge) == []
    assert folds.purge_expired(brain.root, "knowledge/projects/none/memory") == 0


def test_a_pattern_back_under_the_same_id_is_not_overwritten(brain):
    _, merge = _merged(brain)
    write_note(brain.root, Note(path=Path(FOLDED_BACK), meta={}, body="mine"))
    outcome = undo.revert(brain.root, BASE, merge.id)
    assert outcome == {"ok": False, "code": "exists", "mode": "undo"}
    assert read_note(brain.root, FOLDED_BACK).body.strip() == "mine"


def test_a_canonical_pattern_gone_or_hand_edited_still_lets_the_fold_go_back(brain):
    _, merge = _merged(brain)
    note = read_note(brain.root, CANONICAL)
    note.meta["learning"] = {**note.meta["learning"], "confidence": "high"}
    write_note(brain.root, note)
    assert undo.revert(brain.root, BASE, merge.id)["restored"] == [FOLDED_BACK]
    assert _evidence(brain.root, CANONICAL)["confidence"] == "high"


def test_a_fold_goes_back_when_its_canonical_pattern_is_gone(brain):
    _, merge = _merged(brain)
    (kept,) = folds.kept(brain.root, BASE, merge)
    (brain.root / CANONICAL).unlink()
    outcome = folds.unfold(
        brain.root, BASE, [kept], actor="user", reason_code="unmerged", undoes=""
    )
    assert outcome["restored"] == [FOLDED_BACK]
    (restore,) = [e for e in journal.read(brain.root, BASE) if e.action == "restore"]
    assert restore.related == [CANONICAL]


def test_the_same_pattern_seen_again_is_no_fold(brain):
    from learning_loop.pattern_storage import PatternStorage

    storage = PatternStorage(project="shop")
    storage.add_patterns([_pattern()])
    storage.add_patterns([_pattern()])
    (merge,) = [e for e in journal.read(brain.root, BASE) if e.action == "merge"]
    assert merge.related == [] and folds.kept(brain.root, BASE, merge) == []


def test_a_canonical_without_evidence_is_left_as_it_is(brain):
    write_note(brain.root, Note(path=Path(CANONICAL), meta={"title": "x"}, body="x"))
    folds._unshare(brain.root, CANONICAL, folds._share({"occurrences": 1}))
    assert read_note(brain.root, CANONICAL).meta == {"title": "x"}


def test_a_share_without_a_boost_or_lists_leaves_those_alone(brain):
    evidence = {"occurrence_count": 4, "confidence": 0.5, "context_tags": "db"}
    write_note(brain.root, Note(path=Path(CANONICAL), meta={"learning": evidence}))
    folds._unshare(brain.root, CANONICAL, folds._share({"occurrences": 1}))
    assert _evidence(brain.root, CANONICAL) == {
        "occurrence_count": 3,
        "confidence": 0.5,
        "context_tags": "db",
        "source_build_ids": None,
    }


def test_hostile_or_broken_folds_are_refused(brain):
    note = Note(path=Path(FOLDED_BACK), meta={}, body="x")
    assert folds.keep(brain.root, BASE, "../../x.md", note, share={}) is None
    gotcha = Note(path=Path(f"{BASE}/gotchas/x.md"), meta={}, body="x")
    assert folds.keep(brain.root, BASE, CANONICAL, gotcha, share={}) is None

    elsewhere = f"{BASE}/.lifecycle/folded/patterns/elsewhere--1.md"
    write_note(
        brain.root,
        Note(
            path=Path(elsewhere),
            meta={
                "lifecycle": {
                    "was": f"{BASE}/patterns/elsewhere.md",
                    "canonical": "../../outside.md",
                    "restore_until": "2999-01-01T00:00:00+00:00",
                }
            },
            body="x",
        ),
    )
    hand = f"{BASE}/.lifecycle/folded/patterns/hand--1.md"
    write_note(
        brain.root,
        Note(
            path=Path(hand),
            meta={
                "lifecycle": {
                    "was": "../../../etc/passwd.md",
                    "restore_until": "2999-01-01T00:00:00+00:00",
                }
            },
            body="x",
        ),
    )
    broken = f"{BASE}/.lifecycle/folded/patterns/broken--1.md"
    write_note(brain.root, Note(path=Path(broken), meta={"lifecycle": "x"}, body=""))
    entry = JournalEntry(
        action="merge",
        actor="learning-loop",
        note=CANONICAL,
        related=[
            hand,
            broken,
            "../../x.md",
            f"{BASE}/.lifecycle/folded/patterns/no.md",
        ],
    )
    assert folds.kept(brain.root, BASE, entry) == [hand]
    assert folds.unfold(
        brain.root, BASE, [hand, "missing"], actor="user", reason_code="x", undoes=""
    ) == {"ok": False, "code": "not-found"}
    # A canonical path that is not a pattern of this memory is left alone.
    got = folds.unfold(
        brain.root, BASE, [elsewhere], actor="user", reason_code="unmerged", undoes=""
    )
    assert got["restored"] == [f"{BASE}/patterns/elsewhere.md"]
    # Purging reads every fold: one that leads out of the brain is skipped.
    outside = brain.root.parent / "outside.md"
    outside.write_text("---\n---\n", encoding="utf-8")
    link = brain.root / BASE / ".lifecycle" / "folded" / "patterns" / "link--1.md"
    link.symlink_to(outside)
    assert folds.purge_expired(brain.root, BASE) == 1
    assert outside.exists() and link.is_symlink()


def test_a_fold_the_disk_refuses_to_delete_stays(brain, monkeypatch):
    _, merge = _merged(brain)
    later = datetime.now(UTC) + timedelta(days=31)

    def refuse(self, *args, **kwargs):
        raise PermissionError("read-only")

    monkeypatch.setattr(Path, "unlink", refuse)
    assert folds.purge_expired(brain.root, BASE, now=later) == 0


def test_a_share_a_hand_edit_broke_takes_nothing():
    assert folds._share({"occurrences": "many", "builds": "b1"}) == {
        "occurrences": 0,
        "builds": [],
        "tags": [],
        "boost": 0.0,
    }
    assert folds._share(None)["boost"] == 0.0
    assert folds._share({"boost": 9})["boost"] == 0.5


def test_no_brain_keeps_nothing(tmp_path, monkeypatch):
    monkeypatch.setenv("BRAIN_ENABLED", "false")
    memory = ProjectMemory(project="shop", brain=Brain(tmp_path / "none"))
    assert (
        memory.keep_folded("a", {"pattern_id": "b"}, title="", body="", share={})
        is None
    )


def test_a_fold_the_disk_refuses_to_keep_leaves_the_merge_explained(brain, monkeypatch):
    def full(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(folds, "keep", full)
    _, merge = _merged(brain)
    assert merge.related == []
    assert _evidence(brain.root, CANONICAL)["occurrence_count"] == 5
