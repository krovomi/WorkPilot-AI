"""A project's memory on the inputs and failures the round trips in
``test_brain_project_memory`` do not use: what a model writes in another shape,
notes a person or another machine left in the folder, a vault that cannot be
created or synced, and the asynchronous surface the agents call."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from brain import Brain, project_memory
from brain.notes import Note, read_note, write_note
from brain.project_memory import (
    LEGACY_MIGRATED,
    ProjectMemory,
    get_graph_hints,
    import_legacy_spec_memory,
    open_project_memory,
    search_memories,
)

BASE = Path("knowledge/projects/shop/memory")


@pytest.fixture
def vault(tmp_path, monkeypatch):
    root = tmp_path / "vault"
    monkeypatch.setenv("WORKPILOT_BRAIN_DIR", str(root))
    monkeypatch.setenv("BRAIN_PULL_INTERVAL", "0")
    monkeypatch.delenv("BRAIN_ENABLED", raising=False)
    return root


@pytest.fixture
def spec(tmp_path):
    folder = tmp_path / "shop" / ".workpilot" / "specs" / "001-login"
    folder.mkdir(parents=True)
    return folder


@pytest.fixture
def memory(vault, spec):
    made = ProjectMemory(spec)
    assert made.record_gotcha("Close the DB connection in workers")
    return made


def bodies(root: Path, kind: str) -> list[str]:
    folder = root / BASE / kind
    return sorted(
        read_note(root, p.relative_to(root)).body for p in folder.rglob("*.md")
    )


def run(coroutine):
    return asyncio.run(coroutine)


class TestWhatAModelWrites:
    def test_a_list_written_as_one_text_is_one_entry(self, vault, memory):
        wrote = memory.record_structured(
            {
                "patterns_discovered": "Use the repository for every query",
                "gotchas_discovered": "Webhooks retry for an hour",
                "file_insights": "not a list of files",
            }
        )

        assert wrote
        assert len(bodies(vault, "patterns")) == 1
        assert len(bodies(vault, "gotchas")) == 2  # with the fixture's

    def test_a_session_whose_discoveries_have_another_shape(self, vault, memory):
        assert memory.record_session(
            1,
            {
                "discoveries": ["a list", "not a map"],
                "subtasks_completed": "1.1",
            },
        )
        assert memory.record_session(
            2, {"discoveries": {"files_understood": "src/app.py"}}
        )

        [first, second] = memory.load_sessions()
        assert first["subtasks_completed"] == ["1.1"]
        assert second["session_number"] == 2
        assert not (vault / BASE / "codebase").exists()

    def test_structured_insights_in_every_item_shape(self, vault, memory):
        memory.record_structured(
            {
                "file_insights": [
                    "src/a.py",
                    {"path": "src/b.py", "purpose": "Auth", "changes_made": "JWT"},
                ],
                "patterns_discovered": [
                    "Plain pattern",
                    {"pattern": "Factories", "applies_to": "tests", "example": "f()"},
                ],
                "gotchas_discovered": [
                    "Plain gotcha",
                    {"gotcha": "Timeouts", "trigger": "CI", "solution": "Retry"},
                ],
                "subtask_id": "1.2",
                "approach_outcome": {
                    "success": True,
                    "approach_used": "Refactor",
                    "why_it_worked": "Smaller units",
                    "alternatives_tried": "Rewrite",
                },
                "changed_files": "src/b.py",
            }
        )

        assert memory.load_codebase_map() == {"src/b.py": "Auth"}
        [codebase] = bodies(vault, "codebase")
        assert "**Dernière modification :** JWT" in codebase
        patterns = "\n".join(bodies(vault, "patterns"))
        assert "**S'applique à :** tests" in patterns and "```\nf()\n```" in patterns
        [outcome] = bodies(vault, "outcomes")
        assert "**Pourquoi ça a marché :** Smaller units" in outcome
        assert "**Essayé aussi :**\n- Rewrite" in outcome
        assert "**Fichiers :**\n- `src/b.py`" in outcome

    @pytest.mark.parametrize(
        ("call", "args"),
        [
            ("record_gotcha", ("  ",)),
            ("record_pattern", ("",)),
            ("record_discovery", ("src/a.py", " ")),
            ("record_discovery", ("", "Auth")),
        ],
    )
    def test_nothing_to_say_is_not_written(self, memory, call, args):
        assert getattr(memory, call)(*args) is False

    def test_a_learned_pattern_needs_its_id_and_a_text(self, memory):
        assert memory.record_learned_pattern({}, title="t", body="b") is None
        assert (
            memory.record_learned_pattern({"pattern_id": "p1"}, title="", body="")
            is None
        )


class TestNotesInTheFolder:
    def test_hidden_conflicted_unreadable_and_unmapped_notes(
        self, vault, memory, monkeypatch
    ):
        folder = BASE / "codebase"
        for name in (".draft.md", "a.conflict-1.md", "broken.md", "nofile.md"):
            write_note(vault, Note(path=folder / name, meta={}, body="x"))
        real = project_memory.read_note

        def unreadable(root, rel):
            if str(rel).endswith("broken.md"):
                raise ValueError("bad frontmatter")
            return real(root, rel)

        monkeypatch.setattr(project_memory, "read_note", unreadable)

        assert memory.load_codebase_map() == {}
        assert [h["path"] for h in memory.search("", kinds=("codebase",))] == [
            (folder / "nofile.md").as_posix()
        ]

    def test_sessions_of_another_spec_are_left_out_unless_asked(
        self, vault, memory, tmp_path
    ):
        other = tmp_path / "shop" / ".workpilot" / "specs" / "002-cart"
        other.mkdir(parents=True)
        ProjectMemory(other).record_session(1, {"what_worked": ["tests first"]})

        assert memory.load_sessions() == []
        assert [s["spec"] for s in memory.load_sessions(spec_only=False)] == [
            "002-cart"
        ]


class TestSearch:
    def test_short_words_match_only_exactly(self, memory):
        memory.record_gotcha("The apis answer in UTC")

        assert memory.search("api") == []
        assert memory.search("apis")

    def test_a_note_without_words_never_matches(self, vault, memory):
        write_note(vault, Note(path=BASE / "gotchas" / "x.md", meta={}, body="a b c"))
        assert [h["path"] for h in memory.search("close workers")] == [
            (BASE / "gotchas" / "close-the-db-connection-in-workers.md").as_posix()
        ]

    def test_a_minimum_score_leaves_weak_matches_out(self, memory):
        memory.record_gotcha("Workers restart nightly, then warm caches and queues")

        hits = memory.search("close the connection workers", min_score=0.9)

        assert [h["content"].splitlines()[0] for h in hits] == [
            "Close the DB connection in workers"
        ]

    def test_status_counts_each_kind(self, memory):
        status = memory.get_status_summary()
        assert status["initialized"] and status["counts"]["gotcha"] == 1
        assert status["spec"] == "001-login"

    def test_search_memories_without_a_project(self, vault):
        assert search_memories("", "anything") == []


class TestTheVault:
    def test_memory_without_a_project_is_off(self, vault):
        memory = ProjectMemory()
        assert memory.project == "" and not memory.is_enabled
        assert open_project_memory() is None

    def test_a_vault_that_cannot_be_created(self, vault, spec, monkeypatch, caplog):
        def refused(self, *a, **k):
            raise OSError("read-only")

        monkeypatch.setattr(Brain, "init", refused)

        memory = ProjectMemory(spec)
        assert memory.record_gotcha("x y z") is False
        assert not memory.is_initialized
        handed = ProjectMemory(spec, brain=Brain(vault))
        assert handed.record_gotcha("x y z") is False
        assert caplog.text.count("could not create the vault") == 2

    def test_a_vault_another_build_created_meanwhile(self, vault, spec, monkeypatch):
        Brain(vault).init()
        answers = iter([False, True, True])
        real = Brain.exists
        monkeypatch.setattr(
            Brain,
            "exists",
            property(lambda self: next(answers, True) and real.fget(self)),
        )
        monkeypatch.setattr(
            Brain, "init", lambda self, *a, **k: pytest.fail("created twice")
        )

        assert ProjectMemory(spec)._get_brain(create=True) is not None

    def test_a_pull_that_fails_still_reads_the_disk(self, memory, monkeypatch):
        def offline(self):
            raise OSError("no network")

        monkeypatch.setattr(Brain, "before_read", offline)
        reader = ProjectMemory(memory.spec_dir)

        assert reader.load_gotchas() == ["Close the DB connection in workers"]

    def test_a_sync_that_fails_keeps_the_notes(self, vault, memory, monkeypatch):
        def offline(self, message):
            raise OSError("no network")

        monkeypatch.setattr(Brain, "after_write", offline)

        assert memory.flush() is False
        assert len(bodies(vault, "gotchas")) == 1

    def test_forgetting_a_kind_that_does_not_exist_or_failing_to(
        self, memory, monkeypatch, caplog
    ):
        assert memory.forget("dream", "x") is False

        def busy(*_a, **_k):
            raise OSError("busy")

        monkeypatch.setattr(project_memory.lifecycle_store, "forget", busy)

        assert memory.forget("gotcha", "close the db connection in workers") is False
        assert "memory note not forgotten" in caplog.text


class TestAsyncSurface:
    def test_what_the_agents_call(self, memory):
        assert run(memory.initialize()) is True
        assert run(memory.save_codebase_discoveries({"src/a.py": "Entry point"}))
        assert run(memory.save_pattern("Small commits"))
        assert run(memory.save_gotcha("Flaky clock in CI"))
        assert run(memory.save_task_outcome("1.1", False, "Timeout", None))
        assert run(memory.save_structured_insights({"gotchas_discovered": []})) is False
        assert run(memory.save_session_insights(1, {"what_worked": ["tests"]}))

        similar = run(memory.get_similar_task_outcomes("timeout 1.1"))
        history = run(memory.get_session_history())
        context = run(memory.get_relevant_context("clock"))
        run(memory.close())

        assert [(o["task_id"], o["success"]) for o in similar] == [("1.1", False)]
        assert [s["session_number"] for s in history] == [1]
        assert "Flaky clock in CI" in context[0]["content"]
        assert memory.flush() is True  # nothing left after close

    def test_failures_are_logged_and_answered_empty(self, memory, monkeypatch, caplog):
        def broken(*_a, **_k):
            raise RuntimeError("bug")

        monkeypatch.setattr(memory, "search", broken)
        monkeypatch.setattr(memory, "record_pattern", broken)

        assert run(memory.get_patterns_and_gotchas("x")) == ([], [])
        assert run(memory.get_relevant_context("x")) == []
        assert run(memory.save_pattern("x")) is False
        assert "memory read failed" in caplog.text
        assert "memory write failed" in caplog.text


class TestHints:
    def test_enough_memory_hits_skip_the_vault(self, memory, spec, monkeypatch):
        monkeypatch.setattr(
            Brain, "recall", lambda *_a, **_k: pytest.fail("recall asked")
        )

        hints = run(get_graph_hints("workers", spec.parents[2], 1, spec))

        assert [h["type"] for h in hints] == ["gotcha"]

    def test_vault_notes_fill_up_to_the_limit(self, vault, memory, spec, monkeypatch):
        hits = [
            {"source_file": None},
            {"source_file": "images/a.png"},
            {
                "source_file": "knowledge/deploy.md",
                "frontmatter": {"description": "Deploy on Fridays", "kind": "decision"},
            },
            {"source_file": "knowledge/other.md", "label": "Other"},
            {"source_file": "knowledge/third.md", "label": "Third"},
        ]
        monkeypatch.setattr(Brain, "recall", lambda *_a, **_k: {"hits": hits})

        found = run(get_graph_hints("deploy", spec.parents[2], 2, spec))

        assert found == [
            {
                "content": "Deploy on Fridays",
                "score": 0.5,
                "type": "decision",
                "path": "knowledge/deploy.md",
            },
            {
                "content": "Other",
                "score": 0.5,
                "type": "knowledge",
                "path": "knowledge/other.md",
            },
        ]

    def test_a_recall_that_fails_leaves_the_memory_hits(
        self, memory, spec, monkeypatch
    ):
        def broken(*_a, **_k):
            raise RuntimeError("index corrupt")

        monkeypatch.setattr(Brain, "recall", broken)

        hints = run(get_graph_hints("workers", spec.parents[2], 5, spec))

        assert [h["type"] for h in hints] == ["gotcha"]

    def test_hints_that_fail_are_none(self, memory, monkeypatch, caplog):
        def broken(*_a, **_k):
            raise RuntimeError("bug")

        monkeypatch.setattr(project_memory, "_graph_hints", broken)

        assert run(get_graph_hints("x")) == []
        assert "hints failed" in caplog.text


class TestLegacyImport:
    def legacy(self, spec: Path, **files: str) -> Path:
        folder = spec / "memory"
        folder.mkdir(exist_ok=True)
        for name, text in files.items():
            path = folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        return folder

    def test_nothing_to_import(self, vault, spec):
        assert import_legacy_spec_memory(spec)["skipped"] == "no-legacy-memory"

    def test_memory_off_imports_nothing(self, vault, spec, monkeypatch):
        self.legacy(spec, **{"gotchas.md": "- x"})
        monkeypatch.setenv("BRAIN_ENABLED", "false")

        assert import_legacy_spec_memory(spec)["skipped"] == "memory-disabled"
        assert (spec / "memory" / "gotchas.md").exists()

    def test_files_in_other_shapes_are_skipped(self, vault, spec):
        self.legacy(
            spec,
            **{
                "codebase_map.json": json.dumps(["not", "a", "map"]),
                "session_insights/session_001.json": "{not json",
                "session_insights/session_002.json": json.dumps(["a list"]),
                "session_insights/session_003.json": json.dumps({"what_worked": ["x"]}),
            },
        )

        report = import_legacy_spec_memory(spec)

        assert report["imported"] == 1
        [session] = ProjectMemory(spec).load_sessions()
        assert session["session_number"] == 3

    def test_unreadable_map_and_private_keys(self, vault, spec):
        self.legacy(
            spec,
            **{
                "codebase_map.json": "{oops",
                "patterns.md": "- Repository pattern",
            },
        )
        assert import_legacy_spec_memory(spec)["imported"] == 1

        other = spec.parent / "002-cart"
        other.mkdir()
        self.legacy(
            other,
            **{
                "codebase_map.json": json.dumps(
                    {"_meta": 1, "last_updated": "x", "src/a.py": "Entry"}
                )
            },
        )
        assert import_legacy_spec_memory(other)["imported"] == 1

    def test_a_second_import_is_set_aside_beside_the_first(self, vault, spec):
        (spec / LEGACY_MIGRATED).mkdir()
        self.legacy(spec, **{"gotchas.md": "- Keep both"})

        import_legacy_spec_memory(spec)

        aside = sorted(p.name for p in spec.iterdir() if p.name != "memory")
        assert aside[0] == LEGACY_MIGRATED and aside[1].startswith(
            LEGACY_MIGRATED + "-"
        )

    def test_files_that_cannot_be_set_aside_are_left_and_logged(
        self, vault, spec, monkeypatch, caplog
    ):
        self.legacy(spec, **{"gotchas.md": "- Keep me"})

        def stuck(self, target):
            raise PermissionError("in use")

        monkeypatch.setattr(Path, "rename", stuck)

        import_legacy_spec_memory(spec)

        assert (spec / "memory" / "gotchas.md").exists()
        assert "could not set aside the legacy memory" in caplog.text

    def test_set_aside_with_nothing_there(self, spec):
        project_memory._set_aside(spec, [spec / "memory" / "gotchas.md"])
        assert not (spec / LEGACY_MIGRATED).exists()
