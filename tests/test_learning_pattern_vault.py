"""The learning loop's patterns live in the shared brain, and only there.

What has to hold (audit lot L7, F7):

* a pattern is **a note of the project's memory**, under
  ``knowledge/projects/<p>/memory/patterns/``, its evidence in the frontmatter,
  and every operation the loop had (merge, toggle, delete, applications,
  outcomes) reads and writes that note;
* the old ``.workpilot/learning_loop/patterns.json`` is **imported on first
  use and moved aside**, never deleted, and never re-imported;
* the patterns reach a prompt **once**: the learning loop's injector, held to
  its token budget, and not a second time through the session memory context;
* the desktop reads them **through the backend**, by project name.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from brain.notes import read_note  # noqa: E402
from brain.project_memory import ProjectMemory  # noqa: E402
from learning_loop.models import LearningPattern  # noqa: E402
from learning_loop.pattern_applicator import PatternApplicator  # noqa: E402
from learning_loop.pattern_storage import PatternStorage  # noqa: E402


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    return root


@pytest.fixture
def project(tmp_path):
    path = tmp_path / "shop"
    path.mkdir()
    return path


def _pattern(**overrides) -> LearningPattern:
    fields = {
        "pattern_id": LearningPattern.generate_id(),
        "category": "qa_pattern",
        "pattern_type": "failure",
        "source": "qa_feedback",
        "description": "Migrations were not run before the tests",
        "confidence": 0.8,
        "occurrence_count": 2,
        "agent_phase": "coding",
        "context_tags": ["db"],
        "actionable_instruction": "Run the migrations before running the tests.",
        "source_build_ids": ["001-login"],
    }
    fields.update(overrides)
    return LearningPattern(**fields)


def _pattern_notes(vault: Path) -> list[Path]:
    return sorted(vault.glob("knowledge/projects/*/memory/patterns/*.md"))


class TestTheVaultIsTheStore:
    def test_a_pattern_is_a_note_with_its_evidence(self, vault, project):
        pattern = _pattern()
        PatternStorage(project).add_patterns([pattern])

        notes = _pattern_notes(vault)
        assert [n.stem for n in notes] == [pattern.pattern_id]
        meta = read_note(vault, notes[0].relative_to(vault)).meta
        assert meta["memory"] == "pattern"
        assert meta["learning"]["confidence"] == pytest.approx(0.8)
        assert meta["learning"]["source_build_ids"] == ["001-login"]
        assert "learning-loop" in meta["tags"]
        assert not (project / ".workpilot" / "learning_loop").exists()

    def test_every_operation_goes_through_the_note(self, vault, project):
        storage = PatternStorage(project)
        pattern = _pattern()
        storage.add_patterns([pattern])

        storage.record_application([pattern.pattern_id])
        storage.record_outcome([pattern.pattern_id], success=True)
        (loaded,) = PatternStorage(project).load_patterns()
        assert (loaded.applied_count, loaded.success_after_apply) == (1, 1)

        assert storage.toggle_pattern(pattern.pattern_id) is False
        assert PatternStorage(project).load_patterns()[0].enabled is False

        assert storage.delete_pattern(pattern.pattern_id) is True
        assert PatternStorage(project).load_patterns() == []
        assert _pattern_notes(vault) == []

    def test_similar_patterns_still_merge(self, vault, project):
        storage = PatternStorage(project)
        first = _pattern()
        storage.add_patterns([first])
        storage.add_patterns(
            [
                _pattern(
                    actionable_instruction="Run the migrations before running tests."
                )
            ]
        )
        (merged,) = storage.load_patterns()
        assert merged.pattern_id == first.pattern_id
        assert merged.occurrence_count == 4
        assert merged.confidence > first.confidence

    def test_memory_off_remembers_nothing_and_keeps_the_old_file(
        self, vault, project, monkeypatch
    ):
        monkeypatch.setenv("BRAIN_ENABLED", "false")
        legacy = project / ".workpilot" / "learning_loop" / "patterns.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps([_pattern().to_dict()]), encoding="utf-8")

        storage = PatternStorage(project)
        assert storage.load_patterns() == []
        storage.add_patterns([_pattern()])
        assert _pattern_notes(vault) == []
        assert legacy.is_file()


class TestTheOldFileIsMigrated:
    def test_imported_on_first_use_then_moved_aside(self, vault, project):
        old = [_pattern(), _pattern(agent_phase="planning")]
        legacy = project / ".workpilot" / "learning_loop" / "patterns.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps([p.to_dict() for p in old]), encoding="utf-8")

        loaded = PatternStorage(project).load_patterns()

        assert {p.pattern_id for p in loaded} == {p.pattern_id for p in old}
        assert not legacy.exists()
        kept = legacy.with_name("patterns.json.migrated-to-brain")
        assert json.loads(kept.read_text(encoding="utf-8"))[0]["pattern_id"] == (
            old[0].pattern_id
        )

    def test_a_second_old_file_is_not_written_over_the_first(self, vault, project):
        legacy = project / ".workpilot" / "learning_loop" / "patterns.json"
        legacy.parent.mkdir(parents=True)
        for _ in range(2):
            legacy.write_text(json.dumps([_pattern().to_dict()]), encoding="utf-8")
            PatternStorage(project).load_patterns()

        assert sorted(p.name for p in legacy.parent.iterdir()) == [
            "patterns.json.migrated-to-brain",
            "patterns.json.migrated-to-brain.2",
        ]
        assert len(PatternStorage(project).load_patterns()) == 2


class TestOneInjector:
    def test_session_memory_leaves_the_learning_patterns_alone(self, vault, project):
        PatternStorage(project).add_patterns([_pattern()])
        memory = ProjectMemory(None, project)
        memory.record_pattern("Name every migration after its ticket")
        memory.flush()

        assert memory.load_patterns() == ["Name every migration after its ticket"]
        import asyncio

        patterns, _ = asyncio.run(
            memory.get_patterns_and_gotchas("migrations tests", min_score=0.0)
        )
        assert all("Run the migrations" not in p["pattern"] for p in patterns)
        # The Memories tab still lists both: one memory, every note visible.
        assert len(memory.search("", kinds=("pattern",), limit=10)) == 2

    def test_the_injector_holds_its_token_budget(self, vault, project):
        storage = PatternStorage(project)
        long = "x" * 1_500
        patterns = [
            _pattern(actionable_instruction=f"{i} {long}", confidence=0.9 - i / 100)
            for i in range(5)
        ]
        storage.add_patterns(patterns)

        block = PatternApplicator(storage).get_instructions_for_phase("coding")

        budget = PatternApplicator.MAX_TOKENS * PatternApplicator.CHARS_PER_TOKEN
        assert block.count(long) == 1
        assert len(block) < budget + 500
        applied = {p.pattern_id: p.applied_count for p in storage.load_patterns()}
        assert applied[patterns[0].pattern_id] == 1
        assert sum(applied.values()) == 1


class TestTheDesktopReadsThroughTheBackend:
    @pytest.fixture
    def client(self, vault):
        from brain.api import router
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(router)
        return TestClient(app)

    def test_list_toggle_delete(self, client, project):
        pattern = _pattern()
        PatternStorage(project).add_patterns([pattern])

        body = client.get(
            "/api/brain/learning-patterns", params={"project_dir": str(project)}
        ).json()
        assert body["success"] is True
        assert [p["pattern_id"] for p in body["patterns"]] == [pattern.pattern_id]
        assert body["summary"]["total_patterns"] == 1

        request = {"project_dir": str(project), "pattern_id": pattern.pattern_id}
        toggled = client.post("/api/brain/learning-patterns/toggle", json=request)
        assert toggled.json() == {"success": True, "enabled": False}
        deleted = client.post("/api/brain/learning-patterns/delete", json=request)
        assert deleted.json() == {"success": True}
        assert PatternStorage(project).load_patterns() == []

    def test_the_project_is_a_name_not_a_directory_opened(self, client, project):
        legacy = project / ".workpilot" / "learning_loop" / "patterns.json"
        legacy.parent.mkdir(parents=True)
        legacy.write_text(json.dumps([_pattern().to_dict()]), encoding="utf-8")

        body = client.get(
            "/api/brain/learning-patterns", params={"project_dir": str(project)}
        ).json()
        assert body["patterns"] == []
        assert legacy.is_file()
