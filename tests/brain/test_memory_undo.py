"""Taking a memory decision back (#348): undo within the hour, separate a merge.

* an automatic forget or a sync arbitration of the last hour is undone: the
  note comes back, the pair waits for a person;
* any archived variant can be separated from its canonical note, at any time;
  a team-consensus note is separated whole;
* each entry is taken back once, journalled with the id it takes back;
* a person's own forget, a purge, an hour-old automation are not offered.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain.lifecycle import arbitration, journal, store, undo
from brain.lifecycle.journal import JournalEntry
from brain.notes import Note, read_note, write_note

BASE = "knowledge/projects/shop/memory"


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    monkeypatch.delenv("BRAIN_CONFLICT_STALE_DAYS", raising=False)
    monkeypatch.delenv("BRAIN_MEMORY_RETENTION_DAYS", raising=False)


def put(root: Path, rel: str, body: str, **meta) -> str:
    write_note(root, Note(path=Path(rel), meta={"project": "shop", **meta}, body=body))
    return rel


def gotcha(name: str) -> str:
    return f"{BASE}/gotchas/{name}.md"


def entries(root: Path) -> list[JournalEntry]:
    return journal.read(root, BASE, limit=500)


def queue(root: Path) -> dict:
    return json.loads((root / arbitration.QUEUE_FILE).read_text(encoding="utf-8"))


def _pinned_pair(root: Path) -> tuple[str, str]:
    """A semantic pair a sync settles alone: ours is pinned."""
    ours = put(
        root,
        gotcha("migrations"),
        "Always run the migrations before the tests.",
        pinned=True,
    )
    theirs = put(
        root, gotcha("no-migrations"), "Never run the migrations before the tests."
    )
    assert arbitration.review_pull(root, [theirs], [])["auto"] == 1
    return ours, theirs


# --------------------------------------------------------------------------- #
# Undo within the hour
# --------------------------------------------------------------------------- #


def test_a_sync_arbitration_of_the_last_hour_is_undone_and_queued(tmp_path):
    ours, theirs = _pinned_pair(tmp_path)
    [archive] = [e for e in entries(tmp_path) if e.action == "archive"]
    modes = undo.revertible(tmp_path, BASE, entries(tmp_path))
    assert modes == {archive.id: "undo"}
    assert undo.last_undo(entries(tmp_path), modes) == archive.id

    outcome = undo.revert(tmp_path, BASE, archive.id)

    assert outcome["ok"] and outcome["mode"] == "undo"
    assert outcome["restored"] == [theirs]
    assert (tmp_path / theirs).is_file()
    assert read_note(tmp_path, ours).meta.get("variants") == []
    [queued] = arbitration.open_conflicts(tmp_path)
    assert queued["id"] == outcome["conflict"] and queued["signal"] == "negation"
    [back] = [e for e in entries(tmp_path) if e.action == "restore"]
    assert back.reason_code == "undone" and back.undoes == archive.id
    # Taken back once.
    assert undo.revertible(tmp_path, BASE, entries(tmp_path)) == {}
    assert undo.revert(tmp_path, BASE, archive.id)["code"] == "not-revertible"


def test_an_hour_old_arbitration_is_only_separated(tmp_path):
    _pinned_pair(tmp_path)
    [archive] = [e for e in entries(tmp_path) if e.action == "archive"]
    later = datetime.now(UTC) + timedelta(hours=2)
    modes = undo.revertible(tmp_path, BASE, entries(tmp_path), now=later)
    assert modes == {archive.id: "unmerge"}
    assert undo.last_undo(entries(tmp_path), modes) is None
    outcome = undo.revert(tmp_path, BASE, archive.id, now=later)
    assert outcome["mode"] == "unmerge"
    [back] = [e for e in entries(tmp_path) if e.action == "restore"]
    assert back.reason_code == "unmerged"


def test_an_automatic_forget_is_undone_from_the_trash(tmp_path):
    rel = put(tmp_path, gotcha("cache"), "Cache keys include the tenant id.")
    store.forget(
        tmp_path, BASE, rel, actor="learning-loop", reason_code="pattern-retired"
    )
    [gone] = entries(tmp_path)

    assert undo.revertible(tmp_path, BASE, entries(tmp_path)) == {gone.id: "undo"}
    outcome = undo.revert(tmp_path, BASE, gone.id)

    assert outcome["ok"] and outcome["mode"] == "undo" and outcome["restored"] == [rel]
    assert (tmp_path / rel).is_file()
    assert entries(tmp_path)[0].undoes == gone.id


def test_an_undo_whose_note_was_written_again_is_refused(tmp_path):
    rel = put(tmp_path, gotcha("cache"), "Cache keys include the tenant id.")
    store.forget(tmp_path, BASE, rel, actor="agent", reason_code="pattern-retired")
    [gone] = entries(tmp_path)
    put(tmp_path, rel, "Cache keys include the region.")
    outcome = undo.revert(tmp_path, BASE, gone.id)
    assert outcome["code"] == "exists" and outcome["restored"] == []


def test_what_is_not_offered(tmp_path):
    rel = put(tmp_path, gotcha("a"), "Cache keys include the tenant id.")
    store.forget(tmp_path, BASE, rel, actor="user")
    other = put(tmp_path, gotcha("b"), "Queues are drained before deploys.")
    first = datetime.now(UTC) - timedelta(minutes=10)
    store.forget(
        tmp_path, BASE, other, actor="agent", reason_code="pattern-retired", now=first
    )
    agent_forget = entries(tmp_path)[-1]
    user_forget = next(e for e in entries(tmp_path) if e.actor == "user")
    # The same note forgotten again since: the old entry names another forget.
    store.restore(tmp_path, BASE, "gotchas/b.md")
    store.forget(tmp_path, BASE, other, actor="agent", reason_code="pattern-retired")
    later = datetime.now(UTC) + timedelta(seconds=5)
    modes = undo.revertible(tmp_path, BASE, entries(tmp_path), now=later)
    assert user_forget.id not in modes and agent_forget.id not in modes
    assert undo.revert(tmp_path, BASE, user_forget.id)["code"] == "not-revertible"
    assert undo.revert(tmp_path, BASE, "0123456789ab")["code"] == "not-found"


def test_crafted_entries_are_judged_on_what_they_name(tmp_path):
    now = datetime.now(UTC)
    ts = now.isoformat(timespec="seconds")
    crafted = [
        JournalEntry(action="archive", actor="sync", note=gotcha("x"), id=""),
        JournalEntry(
            action="archive", actor="sync", note=gotcha("x"), ts=ts, id="aaaaaaaaaaaa"
        ),
        JournalEntry(
            action="forget", actor="agent", note="../etc.md", ts=ts, id="bbbbbbbbbbbb"
        ),
        JournalEntry(
            action="forget",
            actor="agent",
            note=gotcha("gone"),
            ts=ts,
            id="cccccccccccc",
        ),
        JournalEntry(
            action="forget",
            actor="agent",
            note=gotcha("x"),
            ts="nope",
            id="dddddddddddd",
        ),
        JournalEntry(
            action="create", actor="agent", note=gotcha("x"), ts=ts, id="eeeeeeeeeeee"
        ),
        JournalEntry(
            action="archive",
            actor="sync",
            note=gotcha("x"),
            related=[f"{BASE}/.lifecycle/archived/gotchas/missing.md"],
            ts=ts,
            id="ffffffffffff",
        ),
    ]
    assert undo.revertible(tmp_path, BASE, crafted, now=now) == {}


# --------------------------------------------------------------------------- #
# Separate a merge
# --------------------------------------------------------------------------- #


def test_a_textual_pair_whose_other_version_took_the_place_comes_back_beside(tmp_path):
    a = put(tmp_path, gotcha("db"), "Use port 5432.")
    b = put(tmp_path, gotcha("db.conflict-9"), "Use port 6543.", pinned=True)
    arbitration.review_pull(tmp_path, [], [a])
    [archive] = [e for e in entries(tmp_path) if e.action == "archive"]

    outcome = undo.revert(tmp_path, BASE, archive.id)

    [copy] = outcome["restored"]
    assert copy != b and ".conflict-undo-" in copy
    assert read_note(tmp_path, copy).body.strip() == "Use port 5432."
    [queued] = arbitration.open_conflicts(tmp_path)
    assert queued["textual"] and queued["signal"] == "textual"
    assert (queued["a"]["path"], queued["b"]["path"]) == (a, copy)


def test_a_team_consensus_is_separated_whole(tmp_path):
    ours = put(
        tmp_path, gotcha("migrations"), "Always run the migrations before the tests."
    )
    theirs = put(
        tmp_path, gotcha("no-migrations"), "Never run the migrations before the tests."
    )
    arbitration.review_pull(tmp_path, [theirs], [])
    [pair] = arbitration.open_conflicts(tmp_path)
    arbitration.resolve(tmp_path, pair["id"], "dismiss")
    # Dismissed, then taken up again by a person who writes the consensus.
    arbitration.requeue(tmp_path, BASE, ours, theirs, textual=False)
    [pair] = arbitration.open_conflicts(tmp_path)
    done = arbitration.resolve(
        tmp_path, pair["id"], "custom", "Run the migrations in CI only."
    )
    canonical = done["canonical"]
    archive = next(e for e in entries(tmp_path) if e.action == "archive")

    outcome = undo.revert(tmp_path, BASE, archive.id)

    assert sorted(outcome["restored"]) == sorted([ours, theirs])
    assert not (tmp_path / canonical).exists()
    assert [item["path"] for item in store.trash(tmp_path, BASE)] == [canonical]
    [queued] = arbitration.open_conflicts(tmp_path)
    assert {queued["a"]["path"], queued["b"]["path"]} == {ours, theirs}
    assert queued["id"] not in queue(tmp_path)["dismissed"]


def test_a_consensus_lists_only_the_variants_still_archived(tmp_path):
    canonical = put(
        tmp_path,
        gotcha("consensus"),
        "Run the migrations in CI only.",
        source="team-consensus-2026-11-20",
    )
    first = put(tmp_path, gotcha("one"), "Always run the migrations.")
    archived = store.archive(
        tmp_path,
        BASE,
        first,
        canonical=canonical,
        actor="user",
        reason_code="person-wrote",
    )
    note = read_note(tmp_path, canonical)
    note.meta["variants"] = [
        archived,
        "../../etc/passwd",
        f"{BASE}/.lifecycle/archived/gotchas/gone.md",
    ]
    write_note(tmp_path, note)
    entry = next(e for e in entries(tmp_path) if e.action == "archive")

    outcome = undo.revert(tmp_path, BASE, entry.id)

    assert outcome["restored"] == [first] and outcome["conflict"] is None


def test_a_canonical_without_a_variant_list_or_gone(tmp_path):
    canonical = put(
        tmp_path, gotcha("keep"), "Always run the migrations.", variants="by hand"
    )
    loser = put(tmp_path, gotcha("lose"), "Never run the migrations.")
    store.archive(
        tmp_path,
        BASE,
        loser,
        canonical=canonical,
        actor="user",
        reason_code="person-chose",
    )
    entry = next(e for e in entries(tmp_path) if e.action == "archive")
    (tmp_path / canonical).unlink()

    outcome = undo.revert(tmp_path, BASE, entry.id)

    assert outcome["restored"] == [loser] and outcome["conflict"] is None
    consensus = put(
        tmp_path,
        gotcha("consensus"),
        "x",
        source="team-consensus-1",
        variants="by hand",
    )
    assert undo._variants(tmp_path, BASE, consensus) == []


def test_unarchive_refuses_what_it_cannot_place(tmp_path):
    assert undo.unarchive(
        tmp_path,
        BASE,
        f"{BASE}/.lifecycle/archived/gotchas/x.md",
        actor="user",
        reason_code="unmerged",
    ) == {
        "ok": False,
        "code": "not-found",
    }
    hand = put(
        tmp_path, f"{BASE}/.lifecycle/archived/gotchas/hand.md", "x", lifecycle="edited"
    )
    assert (
        undo.unarchive(tmp_path, BASE, hand, actor="user", reason_code="unmerged")[
            "code"
        ]
        == "invalid"
    )
    # Through revert: nothing could be brought back.
    entry = journal.append(
        tmp_path,
        BASE,
        JournalEntry(
            action="archive", actor="user", note=gotcha("hand"), related=[hand]
        ),
    )
    assert undo.revert(tmp_path, BASE, entry.id) == {
        "ok": False,
        "restored": [],
        "conflict": None,
        "mode": "unmerge",
    }


def test_requeue_needs_both_sides_in_a_memory(tmp_path):
    a = put(tmp_path, gotcha("a"), "Use pnpm.")
    assert arbitration.requeue(tmp_path, BASE, a, gotcha("gone"), textual=False) is None
    assert arbitration.requeue(tmp_path, BASE, "notes/x.md", a, textual=False) is None
    b = put(tmp_path, gotcha("b"), "Queues are drained before deploys.")
    first = arbitration.requeue(tmp_path, BASE, a, b, textual=False)
    assert arbitration.requeue(tmp_path, BASE, a, b, textual=False) == first
    [item] = arbitration.open_conflicts(tmp_path)
    assert item["signal"] == "reopened" and item["detail"] == ""


def test_the_journal_keeps_only_an_id_as_what_is_undone(tmp_path):
    kept = journal.append(
        tmp_path,
        BASE,
        JournalEntry(
            action="restore", actor="user", note=gotcha("x"), undoes="0123456789ab"
        ),
    )
    dropped = journal.append(
        tmp_path,
        BASE,
        JournalEntry(
            action="restore", actor="user", note=gotcha("x"), undoes="--> nope"
        ),
    )
    assert kept.undoes == "0123456789ab" and dropped.undoes == ""
    assert {e.undoes for e in entries(tmp_path)} == {"0123456789ab", ""}


# --------------------------------------------------------------------------- #
# The figures
# --------------------------------------------------------------------------- #


def test_the_figures_come_from_the_journal(tmp_path):
    from brain.lifecycle import metrics

    assert metrics.compute(tmp_path, BASE, [])["pin_rate"] == 0.0
    ours, theirs = _pinned_pair(tmp_path)
    archive = next(e for e in entries(tmp_path) if e.action == "archive")
    undo.revert(tmp_path, BASE, archive.id)
    [pair] = arbitration.open_conflicts(tmp_path)
    arbitration.resolve(tmp_path, pair["id"], "a")
    extra = put(tmp_path, gotcha("cache"), "Cache keys include the tenant id.")
    store.forget(tmp_path, BASE, extra, actor="agent", reason_code="pattern-retired")
    journal.append(
        tmp_path,
        BASE,
        JournalEntry(
            action="resolve",
            actor="user",
            note=gotcha("elsewhere"),
            reason_code="person-chose",
        ),
    )
    crafted = [
        *entries(tmp_path),
        JournalEntry(action="restore", actor="user", note=ours, ts="nope"),
    ]

    figures = metrics.compute(tmp_path, BASE, crafted)

    assert figures["restores_week"] == 1 and figures["undone_week"] == 1
    assert figures["automatic_forgets_week"] == 1
    assert (
        figures["live"] == 1 and figures["pinned"] == 1 and figures["pin_rate"] == 1.0
    )
    assert figures["conflicts_month"] == 1
    assert figures["auto_settled_month"] == 1
    assert figures["resolved_month"] == 2
    assert figures["mean_resolution_hours"] == 0.0
    assert figures["too_aggressive"] is False
    assert figures["history_views"] == 0


def test_the_why_views_are_counted_on_this_machine(tmp_path):
    from brain.lifecycle import metrics

    metrics.count_view(tmp_path, BASE)
    metrics.count_view(tmp_path, BASE)
    assert metrics.views(tmp_path, BASE) == 2
    (tmp_path / metrics.VIEWS_FILE).write_text('{"x": "two", "y": 1}', encoding="utf-8")
    assert metrics.views(tmp_path, "y") == 1 and metrics.views(tmp_path, "x") == 0
    (tmp_path / metrics.VIEWS_FILE).write_text("[1]", encoding="utf-8")
    assert metrics.views(tmp_path, BASE) == 0
    (tmp_path / metrics.VIEWS_FILE).write_text("{", encoding="utf-8")
    assert metrics.views(tmp_path, BASE) == 0


def test_a_view_count_that_cannot_be_saved_is_only_logged(tmp_path):
    from brain.lifecycle import metrics

    (tmp_path / ".workpilot-brain").write_text("a file", encoding="utf-8")
    metrics.count_view(tmp_path, BASE)
    assert metrics.views(tmp_path, BASE) == 0


def test_many_restores_in_a_week_say_the_lifecycle_is_too_aggressive(tmp_path):
    from brain.lifecycle import metrics

    ts = datetime.now(UTC).isoformat(timespec="seconds")
    restores = [
        JournalEntry(action="restore", actor="user", note=gotcha(str(n)), ts=ts)
        for n in range(metrics.AGGRESSIVE_RESTORES)
    ]
    assert metrics.compute(tmp_path, BASE, restores)["too_aggressive"] is True


def test_a_canonical_whose_variants_were_edited_by_hand_keeps_them(tmp_path):
    canonical = put(
        tmp_path,
        gotcha("keep"),
        "Always run the migrations before the tests.",
        variants="by hand",
    )
    loser = put(tmp_path, gotcha("lose"), "Never run the migrations before the tests.")
    store.archive(
        tmp_path,
        BASE,
        loser,
        canonical=canonical,
        actor="user",
        reason_code="person-chose",
    )
    entry = next(e for e in entries(tmp_path) if e.action == "archive")

    outcome = undo.revert(tmp_path, BASE, entry.id)

    assert outcome["restored"] == [loser] and outcome["conflict"]
    assert read_note(tmp_path, canonical).meta["variants"] == "by hand"
