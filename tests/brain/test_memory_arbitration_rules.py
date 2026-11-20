"""Each rule that settles a pair after a pull, and the queue a person reads.

The notes are written straight into a vault folder and `review_pull` is
handed what a pull would report, so every rule is exercised on its own,
without a remote — `test_memory_conflicts.py` holds the two-machine story.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain.lifecycle import arbitration, journal
from brain.notes import Note, read_note, write_note

BASE = "knowledge/projects/shop/memory"
OLD = (datetime.now(UTC) - timedelta(days=90)).isoformat()
NEW = datetime.now(UTC).isoformat()


@pytest.fixture(autouse=True)
def _fixed_stale_window(monkeypatch):
    monkeypatch.delenv("BRAIN_CONFLICT_STALE_DAYS", raising=False)


def put(root: Path, rel: str, body: str, **meta) -> str:
    write_note(root, Note(path=Path(rel), meta={"project": "shop", **meta}, body=body))
    return rel


def gotcha(name: str) -> str:
    return f"{BASE}/gotchas/{name}.md"


def queue(root: Path) -> dict:
    return json.loads((root / arbitration.QUEUE_FILE).read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# The rules
# --------------------------------------------------------------------------- #


class TestTextualPairs:
    def test_the_same_statement_keeps_ours_and_merges_the_evidence(self, tmp_path):
        a = put(
            tmp_path,
            gotcha("cache"),
            "Clear the cache after a deploy.",
            learning={"count": 3, "sources": ["s1"], "auto": True, "seen": 2.5},
        )
        b = put(
            tmp_path,
            gotcha("cache.conflict-abc"),
            "clear the cache after a deploy.",
            learning={
                "count": 5,
                "sources": ["s2", "s1"],
                "auto": False,
                "seen": "twice",
                "first": "2026-01-01",
            },
        )

        summary = arbitration.review_pull(tmp_path, [b], [])

        assert summary == {"checked": 1, "auto": 1, "queued": 0}
        learned = read_note(tmp_path, a).meta["learning"]
        assert learned == {
            "count": 5,
            "sources": ["s1", "s2"],
            # A flag is never merged, nor a value of another type over ours.
            "auto": True,
            "seen": 2.5,
            "first": "2026-01-01",
        }
        assert not (tmp_path / b).exists()
        assert read_note(tmp_path, a).meta.get("variants")

    def test_the_same_statement_without_evidence_on_both_sides(self, tmp_path):
        a = put(tmp_path, gotcha("x"), "Pin the Node version.", learning="n/a")
        b = put(tmp_path, gotcha("x.conflict-1"), "Pin the Node version.")

        arbitration.review_pull(tmp_path, [b], [])

        assert read_note(tmp_path, a).meta["learning"] == "n/a"

    def test_their_pinned_version_replaces_ours_at_our_path(self, tmp_path):
        a = put(tmp_path, gotcha("db"), "Use port 5432.")
        b = put(tmp_path, gotcha("db.conflict-9"), "Use port 6543.", pinned=True)

        summary = arbitration.review_pull(tmp_path, [], [a])

        assert summary["auto"] == 1
        kept = read_note(tmp_path, a)
        assert kept.body.strip() == "Use port 6543." and kept.meta["pinned"] is True
        assert not (tmp_path / b).exists()
        [archived] = (tmp_path / BASE / ".lifecycle" / "archived" / "gotchas").glob("*")
        assert "Use port 5432." in archived.read_text(encoding="utf-8")

    def test_our_pinned_version_stays_and_theirs_is_archived(self, tmp_path):
        a = put(tmp_path, gotcha("db"), "Use port 5432.", pinned=True)
        b = put(tmp_path, gotcha("db.conflict-9"), "Use port 6543.")

        arbitration.review_pull(tmp_path, [b], [])

        assert read_note(tmp_path, a).body.strip() == "Use port 5432."
        assert not (tmp_path / b).exists()

    def test_a_loser_gone_before_it_is_archived_links_nothing(
        self, tmp_path, monkeypatch
    ):
        a = put(tmp_path, gotcha("db"), "Use port 5432.", pinned=True)
        b = put(tmp_path, gotcha("db.conflict-9"), "Use port 6543.")
        linked: list = []
        monkeypatch.setattr(arbitration, "archive", lambda *_a, **_k: None)
        monkeypatch.setattr(arbitration, "link_variants", lambda *a: linked.append(a))

        canonical = arbitration._settle(
            tmp_path,
            BASE,
            a,
            b,
            "a",
            textual=True,
            actor="sync",
            reason_code="pinned-wins",
        )

        assert canonical == a and linked == []

    def test_the_more_confident_pattern_wins(self, tmp_path):
        a = put(
            tmp_path,
            f"{BASE}/patterns/retry.md",
            "Retry three times.",
            learning={"confidence": 0.5},
        )
        b = put(
            tmp_path,
            f"{BASE}/patterns/retry.conflict-2.md",
            "Retry five times.",
            learning={"confidence": "0.9"},
        )

        arbitration.review_pull(tmp_path, [b], [])

        assert read_note(tmp_path, a).body.strip() == "Retry five times."

    def test_textual_pairs_are_never_settled_by_age(self, tmp_path):
        put(tmp_path, gotcha("t"), "Use tabs.", updated=OLD)
        b = put(
            tmp_path,
            gotcha("t.conflict-3"),
            "Use spaces.",
            updated=NEW,
            learning={"confidence": "high"},
        )

        summary = arbitration.review_pull(tmp_path, [b], [])

        assert summary["queued"] == 1
        [item] = arbitration.open_conflicts(tmp_path)
        assert item["textual"] is True and item["kind"] == "gotcha"
        assert item["b"]["confidence"] is None


class TestReceivedContradictions:
    def test_the_newer_note_wins_after_the_stale_window(self, tmp_path):
        ours = put(
            tmp_path,
            gotcha("ours"),
            "Always run the migrations before the tests.",
            updated=OLD,
        )
        theirs = put(
            tmp_path,
            gotcha("theirs"),
            "Never run the migrations before the tests.",
            updated=NEW,
        )

        summary = arbitration.review_pull(tmp_path, [theirs], [])

        assert summary == {"checked": 1, "auto": 1, "queued": 0}
        assert not (tmp_path / ours).exists() and (tmp_path / theirs).exists()

    def test_a_date_that_does_not_parse_leaves_it_to_a_person(self, tmp_path):
        put(
            tmp_path,
            gotcha("ours"),
            "Always run the migrations before the tests.",
            updated="last spring",
            agents="coder",
            tasks=["001", 2],
        )
        theirs = put(
            tmp_path,
            gotcha("theirs"),
            "Never run the migrations before the tests.",
            created=NEW,
        )

        assert arbitration.review_pull(tmp_path, [theirs], [])["queued"] == 1
        [item] = arbitration.open_conflicts(tmp_path, BASE)
        # A single agent written by hand is one agent, not five letters.
        assert item["a"]["agents"] == ["coder"]
        assert item["a"]["tasks"] == ["001", "2"]
        assert item["signal"] == "negation"
        assert arbitration.open_conflicts(tmp_path, "knowledge/projects/x/memory") == []

    def test_a_pair_already_queued_is_not_queued_twice(self, tmp_path):
        put(tmp_path, gotcha("a"), "Always lint before a commit.")
        b = put(tmp_path, gotcha("b"), "Never lint before a commit.")

        arbitration.review_pull(tmp_path, [b], [])
        summary = arbitration.review_pull(tmp_path, [b], [])

        assert summary == {"checked": 0, "auto": 0, "queued": 0}
        assert len(queue(tmp_path)["open"]) == 1

    def test_a_note_settled_earlier_in_the_pull_stops_the_scan(self, tmp_path):
        # The received note is the older one and two newer notes contradict it:
        # the first pair archives it, so there is nothing left to compare.
        received = put(
            tmp_path, gotcha("received"), "Always deploy on a Friday.", updated=OLD
        )
        put(tmp_path, gotcha("n1"), "Never deploy on a Friday.", updated=NEW)
        put(tmp_path, gotcha("n2"), "Never deploy on a Friday evening.", updated=NEW)

        summary = arbitration.review_pull(tmp_path, [received], [])

        assert summary == {"checked": 1, "auto": 1, "queued": 0}
        assert not (tmp_path / received).exists()

    def test_what_is_not_a_checked_memory_is_left_alone(self, tmp_path):
        gone = gotcha("gone")
        session = put(tmp_path, f"{BASE}/sessions/s.md", "Never stop.")
        note = put(tmp_path, "notes/x.md", "Always go.")
        copy = put(tmp_path, "notes/x.conflict-1.md", "Never go.")

        summary = arbitration.review_pull(
            tmp_path, [gone, session, note, copy], ["../../outside.md"]
        )

        assert summary == {"checked": 0, "auto": 0, "queued": 0}

    def test_a_note_that_cannot_be_read_is_skipped(self, tmp_path, monkeypatch):
        put(tmp_path, gotcha("a"), "Always lint before a commit.")
        b = put(tmp_path, gotcha("b"), "Never lint before a commit.")
        real = arbitration.read_note

        def unreadable(root, rel):
            if str(rel).endswith("a.md"):
                raise OSError("busy")
            return real(root, rel)

        monkeypatch.setattr(arbitration, "read_note", unreadable)

        assert arbitration.review_pull(tmp_path, [b], [])["checked"] == 0

    def test_a_failure_while_reviewing_is_logged_never_raised(
        self, tmp_path, monkeypatch, caplog
    ):
        def broken(_root, _data):
            raise ValueError("disk said no")

        monkeypatch.setattr(arbitration, "_save", broken)

        assert arbitration.review_pull(tmp_path, [], []) == {
            "checked": 0,
            "auto": 0,
            "queued": 0,
        }
        assert "not reviewed" in caplog.text


# --------------------------------------------------------------------------- #
# The queue
# --------------------------------------------------------------------------- #


class TestQueue:
    def write_queue(self, root: Path, data: object) -> None:
        path = root / arbitration.QUEUE_FILE
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding="utf-8")

    def test_a_queue_that_is_not_an_object_is_empty(self, tmp_path):
        self.write_queue(tmp_path, ["x"])
        assert arbitration.open_conflicts(tmp_path) == []

    def test_entries_whose_notes_are_gone_or_outside_drop_out(self, tmp_path):
        a = put(tmp_path, gotcha("a"), "x")
        b = put(tmp_path, gotcha("b"), "y")
        live = {"id": "1", "base": BASE, "a": {"path": a}, "b": {"path": b}}
        self.write_queue(
            tmp_path,
            {
                "open": [
                    live,
                    {"id": "2", "a": {"path": "../../etc/x.md"}, "b": {"path": b}},
                    {"id": "3", "a": "not a side", "b": {"path": b}},
                    {"id": "4", "a": {"path": gotcha("gone")}, "b": {"path": b}},
                ],
                "dismissed": "nope",
            },
        )

        assert arbitration.open_conflicts(tmp_path) == [live]
        assert queue(tmp_path) == {"open": [live], "dismissed": []}

    def test_a_queue_that_cannot_be_written_is_logged(self, tmp_path, caplog):
        (tmp_path / ".workpilot-brain").write_text("a file", encoding="utf-8")

        arbitration._save(tmp_path, {"open": [], "dismissed": []})

        assert "conflict queue not saved" in caplog.text


class TestResolve:
    @pytest.fixture
    def queued(self, tmp_path):
        a = put(tmp_path, gotcha("a"), "Always lint before a commit.", title="Lint")
        b = put(tmp_path, gotcha("b"), "Never lint before a commit.")
        arbitration.review_pull(tmp_path, [b], [])
        [item] = arbitration.open_conflicts(tmp_path)
        return tmp_path, item, a, b

    def test_an_unknown_choice(self, queued):
        root, item, *_ = queued
        assert arbitration.resolve(root, item["id"], "both") == {
            "ok": False,
            "code": "invalid",
        }

    def test_an_unknown_pair(self, queued):
        root, *_ = queued
        assert arbitration.resolve(root, "nope", "a")["code"] == "not-found"

    def test_a_pair_whose_paths_left_the_project_is_invalid(self, queued):
        root, item, *_ = queued
        data = queue(root)
        data["open"][0]["b"] = {"path": "knowledge/projects/other/memory/gotchas/x.md"}
        (root / arbitration.QUEUE_FILE).write_text(json.dumps(data), encoding="utf-8")

        assert arbitration.resolve(root, item["id"], "a")["code"] == "invalid"

    def test_a_pair_settled_elsewhere_is_stale_and_leaves_the_queue(self, queued):
        root, item, _a, b = queued
        (root / b).unlink()

        assert arbitration.resolve(root, item["id"], "a")["code"] == "stale"
        assert queue(root)["open"] == []

    def test_a_queue_side_of_another_shape_resolves_with_no_title(self, queued):
        root, item, a, _b = queued
        data = queue(root)
        data["open"][0]["a"] = {"path": a}
        (root / arbitration.QUEUE_FILE).write_text(json.dumps(data), encoding="utf-8")

        assert arbitration.resolve(root, item["id"], "dismiss") == {
            "ok": True,
            "canonical": None,
        }
        [entry] = [
            e for e in journal.read(root, BASE) if e.reason_code == "not-a-conflict"
        ]
        assert entry.title == ""

    def test_two_canonical_notes_with_one_title_get_two_paths(self, queued):
        root, item, *_ = queued
        taken = f"{BASE}/gotchas/consensus-lint-before-a-commit-when-it-is-fast.md"
        put(root, taken, "x")

        outcome = arbitration.resolve(
            root, item["id"], "custom", "Lint before a commit when it is fast."
        )

        assert outcome["canonical"] == taken.replace(".md", "-2.md")

    def test_a_crowded_folder_gets_a_timestamped_name(self, tmp_path, monkeypatch):
        monkeypatch.setattr(arbitration, "_exists", lambda *_a: True)

        rel = arbitration._free_path(tmp_path, BASE, "gotchas", "Lint")

        assert rel.startswith(f"{BASE}/gotchas/consensus-lint-")
        assert rel.removesuffix(".md").rsplit("-", 1)[1].isdigit()
