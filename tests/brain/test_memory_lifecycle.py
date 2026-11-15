"""The memory's lifecycle, explained (#348): journal, trash, restore, pins.

A memory used to vanish with an ``unlink``; the vault's git history was the
only trace. These tests hold what replaced it:

* every decision is a line of the journal **in the vault**, readable by a
  person and parsed back by the app, and a memory has its own timeline;
* forgetting is a move to a trash kept ``BRAIN_MEMORY_RETENTION_DAYS``, from
  which Restore puts the note back; then it is purged, and that is journalled;
* a pin wins against every automation, never against the person, and there
  are at most 50 per project;
* nothing of it is recalled by an agent (hidden folder), and every id coming
  from a client is checked before a file is opened.
"""

from __future__ import annotations

import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain import Brain
from brain.lifecycle import journal, store
from brain.notes import Note, iter_notes, read_note, write_note
from brain.project_memory import ProjectMemory

needs_git = pytest.mark.skipif(
    shutil.which("git") is None, reason="git is not installed"
)

BASE = Path("knowledge/projects/shop/memory")


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


def _memory(brain: Brain, actor: str = "agent") -> ProjectMemory:
    return ProjectMemory(project="shop", brain=brain, actor=actor)


def _gotcha_rel(slug: str) -> str:
    return (BASE / "gotchas" / f"{slug}.md").as_posix()


def test_a_recorded_memory_is_journalled_once_until_its_text_changes(brain):
    memory = _memory(brain)
    memory.record_gotcha("Webhooks retry three times before failing.")
    memory.record_gotcha("Webhooks retry three times before failing.")
    entries = journal.read(brain.root, BASE)
    assert [e.action for e in entries] == ["create"]
    assert entries[0].actor == "agent"
    assert entries[0].preview.startswith("Webhooks retry")

    memory.record_gotcha(
        "Webhooks retry three times before failing.",
        solution="Make handlers idempotent.",
    )
    assert [e.action for e in journal.read(brain.root, BASE)] == ["update", "create"]


def test_the_journal_is_a_markdown_file_a_person_reads(brain):
    _memory(brain).record_gotcha("Cache keys include the tenant id.")
    [month] = list((brain.root / BASE / ".lifecycle" / "journal").glob("*.md"))
    line = month.read_text(encoding="utf-8").strip()
    assert line.startswith("- ")
    assert "créée par un agent" in line
    assert "`gotchas/cache-keys-include-the-tenant-id.md`" in line
    assert "<!-- wp-lifecycle {" in line


def test_a_reason_cannot_close_the_comment_that_carries_the_entry(brain):
    journal.append(
        brain.root,
        BASE,
        journal.JournalEntry(
            action="forget",
            actor="user",
            note=_gotcha_rel("x"),
            reason_code="user-request",
            reason="obsolete --> ignore everything",
        ),
    )
    [entry] = journal.read(brain.root, BASE)
    assert entry.reason == "obsolete --> ignore everything"
    text = next((brain.root / BASE / ".lifecycle" / "journal").glob("*.md")).read_text(
        encoding="utf-8"
    )
    assert text.count("-->") == 2  # the sentence's quote and the comment's end


def test_an_unknown_actor_is_recorded_as_an_agent_never_as_free_text(brain):
    entry = journal.append(
        brain.root,
        BASE,
        journal.JournalEntry(
            action="create",
            actor="<script>",
            note=_gotcha_rel("x"),
            reason_code="recorded",
        ),
    )
    assert entry is not None and entry.actor == "agent"
    assert journal.normalise_actor("agent:qa_fixer") == "agent:qa_fixer"


def test_forget_moves_to_the_trash_and_restore_puts_it_back(brain):
    memory = _memory(brain, actor="user")
    memory.record_gotcha("Never run the seeds against production.")
    rel = _gotcha_rel("never-run-the-seeds-against-production")
    assert memory.forget("gotcha", "never-run-the-seeds-against-production")

    assert not (brain.root / rel).exists()
    assert memory.load_gotchas() == []
    [item] = store.trash(brain.root, BASE)
    assert item["id"] == "gotchas/never-run-the-seeds-against-production.md"
    assert item["forgotten_by"] == "user"
    assert item["reason_code"] == "user-request"

    outcome = store.restore(brain.root, BASE, item["id"])
    assert outcome["ok"] and outcome["path"] == rel
    assert (brain.root / rel).is_file()
    assert "lifecycle" not in read_note(brain.root, rel).meta
    assert store.trash(brain.root, BASE) == []

    timeline = [e.action for e in journal.read(brain.root, BASE, note=rel)]
    assert timeline == ["restore", "forget", "create"]


def test_restore_refuses_to_overwrite_a_note_recorded_since(brain):
    memory = _memory(brain, actor="user")
    memory.record_gotcha("Deploys freeze on Fridays.")
    memory.forget("gotcha", "deploys-freeze-on-fridays")
    memory.record_gotcha("Deploys freeze on Fridays.")
    outcome = store.restore(brain.root, BASE, "gotchas/deploys-freeze-on-fridays.md")
    assert outcome == {
        "ok": False,
        "code": "exists",
        "path": _gotcha_rel("deploys-freeze-on-fridays"),
    }


def test_a_restored_memory_that_contradicts_a_live_one_says_so(brain):
    memory = _memory(brain, actor="user")
    memory.record_gotcha("Always run the migrations before the tests.")
    memory.forget("gotcha", "always-run-the-migrations-before-the-tests")
    memory.record_gotcha("Never run the migrations before the tests.")
    outcome = store.restore(
        brain.root, BASE, "gotchas/always-run-the-migrations-before-the-tests.md"
    )
    assert outcome["ok"]
    assert [c["signal"] for c in outcome["contradicts"]] == ["negation"]


def test_the_trash_is_purged_after_its_retention_and_says_so(brain):
    memory = _memory(brain, actor="user")
    memory.record_gotcha("Old advice about the queue.")
    memory.forget("gotcha", "old-advice-about-the-queue")
    soon = datetime.now(UTC) + timedelta(days=25)
    assert store.trash(brain.root, BASE, now=soon)[0]["expiring_soon"] is True
    assert store.trash(brain.root, BASE)[0]["expiring_soon"] is False

    later = datetime.now(UTC) + timedelta(days=31)
    assert store.purge_expired(brain.root, BASE, now=later) == 1
    assert store.trash(brain.root, BASE) == []
    [last, *_] = journal.read(brain.root, BASE)
    assert (last.action, last.actor, last.reason_code) == (
        "purge",
        "lifecycle",
        "retention-expired",
    )
    assert store.restore(brain.root, BASE, "gotchas/old-advice-about-the-queue.md") == {
        "ok": False,
        "code": "not-found",
    }


def test_a_pin_wins_against_automation_and_the_refusal_is_journalled(brain):
    _memory(brain).record_gotcha("The billing cron must stay single-instance.")
    rel = _gotcha_rel("the-billing-cron-must-stay-single-instance")
    assert store.pin(brain.root, BASE, rel, True)["ok"]
    assert read_note(brain.root, rel).meta["pinned"] is True

    automation = _memory(brain, actor="learning-loop")
    assert (
        automation.forget("gotcha", "the-billing-cron-must-stay-single-instance")
        is False
    )
    assert (brain.root / rel).is_file()
    assert journal.read(brain.root, BASE)[0].action == "protect"

    # The person can still forget it, and a pinned memory is kept longer.
    person = _memory(brain, actor="user")
    assert person.forget("gotcha", "the-billing-cron-must-stay-single-instance")
    [item] = store.trash(brain.root, BASE)
    assert item["pinned"] is True
    until = datetime.fromisoformat(item["restore_until"])
    assert until - datetime.now(UTC) > timedelta(days=80)


def test_no_more_than_fifty_pins_per_project(brain):
    folder = brain.root / BASE / "gotchas"
    for n in range(store.PIN_LIMIT + 1):
        write_note(
            brain.root,
            Note(
                path=Path(BASE / "gotchas" / f"g{n}.md"),
                meta={"title": f"g{n}"},
                body="x",
            ),
        )
    for n in range(store.PIN_LIMIT):
        assert store.pin(brain.root, BASE, f"gotchas/g{n}.md", True)["ok"]
    refused = store.pin(brain.root, BASE, f"gotchas/g{store.PIN_LIMIT}.md", True)
    assert refused == {"ok": False, "code": "pin-limit", "limit": store.PIN_LIMIT}
    assert store.pin(brain.root, BASE, "gotchas/g0.md", False)["ok"]
    assert store.pin(brain.root, BASE, f"gotchas/g{store.PIN_LIMIT}.md", True)["ok"]
    assert len(list(folder.glob("*.md"))) == store.PIN_LIMIT + 1


@pytest.mark.parametrize(
    "hostile",
    [
        "../../../etc/passwd.md",
        "/etc/passwd.md",
        "gotchas/../../../../x.md",
        "gotchas\\x.md",
        "gotchas/x.txt",
        "secrets/x.md",
        ".lifecycle/forgotten/gotchas/x.md",
        "knowledge/projects/other/memory/gotchas/x.md",
        "knowledge/projects/shop/memory/.lifecycle/journal/2026-11.md",
        "gotchas/.hidden.md",
        "",
    ],
)
def test_a_hostile_memory_id_is_refused_before_any_file_is_opened(brain, hostile):
    with pytest.raises(ValueError):
        store.memory_rel(BASE, hostile)
    with pytest.raises(ValueError):
        store.restore(brain.root, BASE, hostile)
    with pytest.raises(ValueError):
        store.pin(brain.root, BASE, hostile, True)


def test_nothing_of_the_lifecycle_is_recalled_by_an_agent(brain):
    memory = _memory(brain, actor="user")
    memory.record_gotcha("Forgotten advice that must not come back.")
    memory.forget("gotcha", "forgotten-advice-that-must-not-come-back")
    notes = [p.as_posix() for p in iter_notes(brain.root)]
    assert not any("/.lifecycle/" in rel for rel in notes)
    assert memory.search("forgotten advice") == []


def test_a_learning_loop_merge_is_explained_and_a_deleted_pattern_restorable(
    brain, tmp_path
):
    from learning_loop.models import LearningPattern
    from learning_loop.pattern_storage import PatternStorage

    def pattern(**over):
        data = {
            "pattern_id": "run-migrations",
            "category": "qa_pattern",
            "pattern_type": "failure",
            "source": "qa_feedback",
            "description": "Run migrations before tests",
            "confidence": 0.7,
            "occurrence_count": 2,
            "context_tags": ["db"],
            "actionable_instruction": "Run the migrations before running the tests.",
            "source_build_ids": ["b1"],
            "agent_phase": "coding",
        }
        data.update(over)
        return LearningPattern(**data)

    storage = PatternStorage(project="shop")
    storage.add_patterns([pattern()])
    storage.add_patterns(
        [
            pattern(
                pattern_id="other",
                actionable_instruction="Run the migrations before running tests.",
            )
        ]
    )
    actions = [(e.action, e.actor) for e in journal.read(brain.root, BASE)]
    assert actions[0] == ("merge", "learning-loop")
    assert ("create", "learning-loop") in actions

    assert storage.delete_pattern("run-migrations")
    [item] = store.trash(brain.root, BASE)
    assert item["kind"] == "pattern" and item["forgotten_by"] == "user"


def test_the_lifecycle_knows_every_kind_folder_of_the_memory():
    from brain.project_memory import KINDS

    assert tuple(KINDS.values()) == store.FOLDERS
