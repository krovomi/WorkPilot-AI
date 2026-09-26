"""The hermes review queue, answered from the task panel — and fed to the brain.

A person reported the panel exactly as it was: thirty-four file paths under
``skills/_proposed/`` and nothing to do with any of them. These tests hold the
two answers that replaced that list, and the coupling with the shared brain
that makes a kept skill something every agent can recall:

* **keep** adopts the candidate into the same pack the loop adopts into, and
  files it in the brain as knowledge — linked to the task it was kept from;
* **turn down** records the refusal in the adoption ledger, removes the file,
  and the loop never proposes, mirrors or adopts that name again;
* the loop's own adoptions reach the brain too, so the learning is fed whether
  or not anyone opens the panel.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from brain.vault import Brain  # noqa: E402
from hermes.brain_link import FOLDER, brain_link, note_rel  # noqa: E402
from learning_loop.hermes_adopt import (  # noqa: E402
    ADOPTED_PACK,
    declined_names,
    ledger_names,
)
from learning_loop.hermes_ingest import ingest_hermes_skills, queue_state  # noqa: E402
from learning_loop.hermes_review import candidate_details, decide  # noqa: E402


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    (root / "skills" / "hermes").mkdir(parents=True)
    (root / "skills" / "hermes" / "pack.json").write_text(
        json.dumps({"name": "hermes", "bootstrap": {"command": []}}),
        encoding="utf-8",
    )
    return root


@pytest.fixture
def home(tmp_path: Path) -> Path:
    root = tmp_path / "hermes-home"
    (root / "skills").mkdir(parents=True)
    return root


@pytest.fixture(autouse=True)
def no_brain(tmp_path, monkeypatch):
    """No test here may write into the brain of whoever runs the suite."""
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(tmp_path / "absent-brain"))
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    monkeypatch.setenv("BRAIN_AUTO_PUSH", "false")
    monkeypatch.setenv("BRAIN_AUTO_PULL", "false")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)


@pytest.fixture
def brain(tmp_path, monkeypatch) -> Brain:
    root = tmp_path / "brain"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.setenv("WORKPILOT_BRAIN_HOME", str(tmp_path / "agents-home"))
    b = Brain(root)
    b.init()
    return b


def _authored(
    home: Path, name: str, description: str = "Diagnose a flaky test."
) -> None:
    path = home / "skills" / name / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n"
        "1. Re-run the test with `terminal`.\n2. Read the log with `read_file`.\n",
        encoding="utf-8",
    )
    usage = home / "skills" / ".usage.json"
    data = json.loads(usage.read_text(encoding="utf-8")) if usage.is_file() else {}
    data[name] = {"created_by": "agent"}
    usage.write_text(json.dumps(data), encoding="utf-8")


def _queued(repo: Path, home: Path, *names: str) -> None:
    """Candidates in the queue and nowhere else — auto-adoption off."""
    for name in names:
        _authored(home, name)
    import os

    os.environ["HERMES_AUTO_ADOPT"] = "false"
    try:
        ingest_hermes_skills(repo, home=home, surface="build")
    finally:
        del os.environ["HERMES_AUTO_ADOPT"]


def _learned(repo: Path, name: str) -> Path:
    return repo / "skills" / ADOPTED_PACK / name / "SKILL.md"


class TestWhatThePanelShows:
    def test_each_candidate_carries_what_a_decision_needs(self, repo, home):
        _queued(repo, home, "diagnose-the-flake")
        [card] = candidate_details(repo)
        assert card["file"] == "hermes--diagnose-the-flake.md"
        assert card["name"] == "diagnose-the-flake"
        assert card["description"] == "Diagnose a flaky test."
        assert "Re-run the test" in card["excerpt"]
        assert card["tools"] == ["terminal", "read_file"]
        assert card["pendingInHermes"] is False

    def test_the_details_and_the_count_are_one_reading(self, repo, home):
        _queued(repo, home, "a-skill", "b-skill")
        pending, _ = queue_state(repo)
        assert [c["file"] for c in candidate_details(repo)] == pending


class TestKeeping:
    def test_keeping_adopts_into_the_loops_pack(self, repo, home):
        _queued(repo, home, "diagnose-the-flake")
        outcome = decide(repo, ["hermes--diagnose-the-flake.md"], "adopt")
        assert outcome.adopted == ["diagnose-the-flake"]
        assert _learned(repo, "diagnose-the-flake").is_file()
        assert "diagnose-the-flake" in ledger_names(repo)
        # Answered: the queue stops asking.
        assert queue_state(repo)[0] == []

    def test_the_adopted_body_is_hermess_own(self, repo, home):
        _queued(repo, home, "diagnose-the-flake")
        decide(repo, ["hermes--diagnose-the-flake.md"], "adopt")
        text = _learned(repo, "diagnose-the-flake").read_text(encoding="utf-8")
        assert "Re-run the test with `terminal`." in text
        assert "adopted: verbatim" in text

    def test_a_kept_skill_is_filed_in_the_brain_linked_to_its_task(
        self, repo, home, brain
    ):
        _queued(repo, home, "diagnose-the-flake")
        outcome = decide(
            repo,
            ["hermes--diagnose-the-flake.md"],
            "adopt",
            task="my-app/001-fix-namespace",
        )
        assert outcome.brain_notes == [note_rel("diagnose-the-flake")]
        note = (brain.root / note_rel("diagnose-the-flake")).read_text(encoding="utf-8")
        assert "kind: knowledge" in note
        assert "my-app/001-fix-namespace" in note
        assert "Re-run the test" in note
        assert "Une personne l'a gardée" in note

    def test_without_a_brain_keeping_still_works(self, repo, home):
        _queued(repo, home, "diagnose-the-flake")
        outcome = decide(repo, ["hermes--diagnose-the-flake.md"], "adopt")
        assert outcome.adopted == ["diagnose-the-flake"]
        assert outcome.brain_notes == []


class TestTurningDown:
    def test_turning_down_removes_the_file_and_records_the_no(self, repo, home):
        _queued(repo, home, "airtable")
        outcome = decide(repo, ["hermes--airtable.md"], "decline")
        assert outcome.declined == ["airtable"]
        assert not (repo / "skills" / "_proposed" / "hermes--airtable.md").exists()
        assert "airtable" in declined_names(repo)
        assert not _learned(repo, "airtable").exists()

    def test_a_refused_name_never_comes_back(self, repo, home):
        _queued(repo, home, "airtable")
        decide(repo, ["hermes--airtable.md"], "decline")

        # Next build, auto-adoption on: neither the mirror nor the pack.
        report = ingest_hermes_skills(repo, home=home, surface="build")
        assert report.adopted == []
        assert not (repo / "skills" / "_proposed" / "hermes--airtable.md").exists()
        assert not _learned(repo, "airtable").exists()
        assert queue_state(repo)[0] == []

    def test_several_at_once(self, repo, home):
        _queued(repo, home, "a-skill", "b-skill", "c-skill")
        outcome = decide(repo, ["hermes--a-skill.md", "hermes--b-skill.md"], "decline")
        assert sorted(outcome.declined) == ["a-skill", "b-skill"]
        assert queue_state(repo)[0] == ["hermes--c-skill.md"]


class TestOnlyTheQueueIsDecided:
    @pytest.mark.parametrize(
        "name",
        ["../../etc/passwd", "hermes--../x.md", "/abs/hermes--x.md", "notes.md", ""],
    )
    def test_a_name_that_is_not_a_queue_file_is_refused(self, repo, home, name):
        _queued(repo, home, "diagnose-the-flake")
        outcome = decide(repo, [name], "decline")
        assert outcome.declined == []
        assert outcome.skipped[0]["reason"] == "invalid-name"

    def test_the_learning_loops_own_proposals_are_not_ours(self, repo, home):
        folder = repo / "skills" / "_proposed"
        folder.mkdir(parents=True)
        (folder / "hermes--lookalike.md").write_text(
            "---\nname: lookalike\n---\n\nSomebody's evidence.\n", encoding="utf-8"
        )
        outcome = decide(repo, ["hermes--lookalike.md"], "decline")
        assert outcome.skipped == [
            {"file": "hermes--lookalike.md", "reason": "not-a-hermes-candidate"}
        ]
        assert (folder / "hermes--lookalike.md").exists()

    def test_an_unknown_decision_touches_nothing(self, repo, home):
        _queued(repo, home, "diagnose-the-flake")
        outcome = decide(repo, ["hermes--diagnose-the-flake.md"], "promote")
        assert outcome.skipped[0]["reason"] == "unknown-decision"
        assert queue_state(repo)[0] == ["hermes--diagnose-the-flake.md"]


class TestTheLoopFeedsTheBrain:
    def test_an_auto_adoption_is_filed_in_the_brain(self, repo, home, brain):
        _authored(home, "diagnose-the-flake")
        report = ingest_hermes_skills(repo, home=home, surface="build")
        assert [p.parent.name for p in report.adopted] == ["diagnose-the-flake"]
        note = brain.root / FOLDER / "diagnose-the-flake.md"
        assert note.is_file()
        assert "La boucle d'apprentissage l'a gardée" in note.read_text(
            encoding="utf-8"
        )

    def test_a_settled_adoption_is_not_refiled(self, repo, home, brain):
        _authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home, surface="build")
        note = brain.root / FOLDER / "diagnose-the-flake.md"
        note.write_text("edited by a person\n", encoding="utf-8")
        ingest_hermes_skills(repo, home=home, surface="build")
        assert note.read_text(encoding="utf-8") == "edited by a person\n"

    def test_the_link_reports_the_brain_and_its_hermes_notes(self, repo, home, brain):
        assert brain_link().active is True
        assert brain_link().notes == 0
        _authored(home, "diagnose-the-flake")
        ingest_hermes_skills(repo, home=home, surface="build")
        assert brain_link().notes == 1

    def test_without_a_brain_the_link_says_so(self):
        link = brain_link()
        assert link.active is False
        assert link.to_dict()["hermesConnected"] is False
