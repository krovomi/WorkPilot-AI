"""The memory store on notes a person edited by hand, and the contradiction
detector on the phrasings its tests did not use yet."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain.lifecycle import contradictions, store
from brain.notes import Note, read_note, write_note

BASE = "knowledge/projects/shop/memory"
NOW = datetime(2026, 11, 16, 12, tzinfo=UTC)


def put(root: Path, rel: str, body: str = "x", **meta) -> str:
    write_note(root, Note(path=Path(rel), meta=meta, body=body))
    return rel


class TestTimestamps:
    def test_a_datetime_without_a_zone_is_utc(self):
        naive = datetime(2026, 1, 1, 8)
        assert store._parse_ts(naive) == naive.replace(tzinfo=UTC)
        assert store._parse_ts(NOW) is NOW

    def test_text_that_is_not_a_date_is_none(self):
        assert store._parse_ts("next week") is None


class TestLiveNotes:
    def test_hidden_conflict_and_outside_folders_are_not_live(
        self, tmp_path, monkeypatch
    ):
        put(tmp_path, f"{BASE}/gotchas/a.md")
        put(tmp_path, f"{BASE}/gotchas/.drafts/b.md")
        put(tmp_path, f"{BASE}/gotchas/a.conflict-1.md")
        put(tmp_path, f"{BASE}/gotchas/c.md")
        real = store.read_note

        def unreadable(root, rel):
            if str(rel).endswith("c.md"):
                raise OSError("busy")
            return real(root, rel)

        monkeypatch.setattr(store, "read_note", unreadable)

        assert [rel for rel, _ in store.iter_live(tmp_path, BASE)] == [
            f"{BASE}/gotchas/a.md"
        ]
        assert list(store.iter_live(tmp_path, "../../x")) == []


class TestPin:
    def test_pinning_what_is_already_pinned_writes_nothing(self, tmp_path):
        rel = put(tmp_path, f"{BASE}/gotchas/a.md", pinned=True, pinned_at="then")

        outcome = store.pin(tmp_path, BASE, rel, True, now=NOW)

        assert outcome == {"ok": True, "pinned": True, "count": 1}
        assert read_note(tmp_path, rel).meta["pinned_at"] == "then"


class TestTrash:
    def forgotten(self, root: Path, name: str, **lifecycle) -> str:
        return put(
            root,
            f"{BASE}/.lifecycle/forgotten/gotchas/{name}.md",
            lifecycle=lifecycle or "edited by hand",
        )

    def test_forgetting_a_note_that_is_gone(self, tmp_path):
        assert store.forget(tmp_path, BASE, "gotchas/none.md", actor="user") == {
            "ok": False,
            "code": "not-found",
        }

    def test_a_lifecycle_of_another_shape_is_read_as_empty(self, tmp_path):
        self.forgotten(tmp_path, "odd")

        [item] = store.trash(tmp_path, BASE, now=NOW)

        assert item["id"] == "gotchas/odd.md"
        assert item["restore_until"] == "" and item["expiring_soon"] is False
        assert store.purge_expired(tmp_path, BASE, now=NOW) == 0
        outcome = store.restore(tmp_path, BASE, "gotchas/odd.md", now=NOW)
        assert (
            outcome["ok"]
            and "lifecycle" not in read_note(tmp_path, outcome["path"]).meta
        )

    def test_an_expired_note_cannot_be_restored(self, tmp_path):
        self.forgotten(
            tmp_path, "old", restore_until=(NOW - timedelta(days=1)).isoformat()
        )

        assert store.restore(tmp_path, BASE, "gotchas/old.md", now=NOW) == {
            "ok": False,
            "code": "expired",
        }

    def test_a_note_that_cannot_be_deleted_is_not_counted(self, tmp_path, monkeypatch):
        rel = self.forgotten(
            tmp_path, "old", restore_until=(NOW - timedelta(days=1)).isoformat()
        )
        real = Path.unlink

        def stuck(self, *args, **kwargs):
            if self.name == "old.md":
                raise PermissionError("in use")
            return real(self, *args, **kwargs)

        monkeypatch.setattr(Path, "unlink", stuck)

        assert store.purge_expired(tmp_path, BASE, now=NOW) == 0
        assert (tmp_path / rel).exists()

    def test_an_unreadable_trash_note_and_a_base_outside(self, tmp_path, monkeypatch):
        self.forgotten(tmp_path, "a", restore_until=NOW.isoformat())
        monkeypatch.setattr(
            store, "read_note", lambda *_a: (_ for _ in ()).throw(OSError("busy"))
        )

        assert store.trash(tmp_path, BASE, now=NOW) == []
        assert store.trash(tmp_path, "../../x", now=NOW) == []


class TestArchive:
    def test_archiving_a_note_that_is_gone(self, tmp_path):
        assert (
            store.archive(
                tmp_path,
                BASE,
                f"{BASE}/gotchas/none.md",
                canonical=f"{BASE}/gotchas/a.md",
                actor="sync",
                reason_code="more-recent",
            )
            is None
        )

    def test_variants_written_as_text_become_a_list(self, tmp_path):
        rel = put(tmp_path, f"{BASE}/gotchas/a.md", variants="old.md")

        store.link_variants(tmp_path, rel, ["new.md", "old.md"])

        assert read_note(tmp_path, rel).meta["variants"] == ["new.md", "old.md"]

    def test_linking_to_a_canonical_note_that_is_gone(self, tmp_path):
        store.link_variants(tmp_path, "../../x.md", ["a.md"])
        assert not (tmp_path.parent / "x.md").exists()


class TestDetectorPhrasings:
    def test_a_setting_both_notes_agree_on_is_not_the_clash(self):
        found = contradictions.compare(
            "Set retries to 3 and timeout to 30.", "Set retries to 3 and timeout to 60."
        )

        assert found is not None
        assert (found.signal, found.detail) == ("value", "timeout: 30 \u2260 60")

    def test_an_article_after_the_verb_is_not_an_object(self):
        found = contradictions.compare(
            "Use a Prisma model for the billing module.",
            "Use Drizzle for the billing module.",
        )

        assert found is not None
        assert (found.signal, found.detail) == (
            "recommendation",
            "model prisma \u2260 drizzle",
        )

    @pytest.mark.parametrize(
        ("a", "b"),
        [
            ("Set retries to 3.", "Set retries to 3."),
            ("Use 2 workers.", "Use 4 workers."),
        ],
    )
    def test_the_same_value_or_a_bare_count_is_no_contradiction(self, a, b):
        assert contradictions.compare(a, b) is None

    def test_only_gotchas_and_patterns_are_checked(self, tmp_path):
        rel = put(tmp_path, f"{BASE}/sessions/a.md", "Never stop.")
        assert contradictions.find_for(tmp_path, BASE, rel) == []

    def test_a_note_that_cannot_be_read(self, tmp_path):
        assert contradictions.find_for(tmp_path, BASE, f"{BASE}/gotchas/none.md") == []
