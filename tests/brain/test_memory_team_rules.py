"""Team knowledge sync, the rules a team keeps (#352).

* a person's decision is journalled with their name (the vault's git
  identity): who voted what, for a post-mortem;
* a pair decided less than a week ago that contradicts again is not settled
  again by a rule: it is escalated, and only a designated maintainer settles
  it (anyone, when the project names none);
* a memory can be scoped to a part of the code, and two notes scoped to
  different places never clash.
"""

from __future__ import annotations

import subprocess
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain.lifecycle import arbitration, identity, journal, maintainers, store
from brain.lifecycle.journal import JournalEntry
from brain.notes import Note, read_note, write_note

BASE = "knowledge/projects/shop/memory"
ALICE = {"name": "Alice Martin", "email": "alice@example.com"}


@pytest.fixture(autouse=True)
def _defaults(monkeypatch):
    for key in ("BRAIN_CONFLICT_STALE_DAYS", "BRAIN_CONFLICT_COOLDOWN_DAYS"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(identity, "person", lambda root: dict(ALICE))


def put(root: Path, rel: str, body: str, **meta) -> str:
    write_note(root, Note(path=Path(rel), meta={"project": "shop", **meta}, body=body))
    return rel


def gotcha(name: str) -> str:
    return f"{BASE}/gotchas/{name}.md"


def _contradicting_pair(root: Path) -> tuple[str, str]:
    ours = put(root, gotcha("always"), "Always run the migrations before the tests.")
    theirs = put(root, gotcha("never"), "Never run the migrations before the tests.")
    return ours, theirs


# --------------------------------------------------------------------------- #
# Who decided
# --------------------------------------------------------------------------- #


def test_a_persons_decision_carries_their_name(tmp_path):
    ours, theirs = _contradicting_pair(tmp_path)
    arbitration.review_pull(tmp_path, [theirs], [])
    [pair] = arbitration.open_conflicts(tmp_path)
    arbitration.resolve(tmp_path, pair["id"], "a")
    resolve = next(e for e in journal.read(tmp_path, BASE) if e.action == "resolve")
    assert resolve.by == "Alice Martin"
    [month] = (tmp_path / BASE / ".lifecycle" / "journal").glob("*.md")
    assert "par la personne (Alice Martin)" in month.read_text(encoding="utf-8")
    # An automation is not a person: no name.
    conflict = next(e for e in journal.read(tmp_path, BASE) if e.action == "conflict")
    assert conflict.by == ""


def test_the_vault_identity_is_read_from_git(tmp_path, monkeypatch):
    monkeypatch.undo()
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    subprocess.run(
        ["git", "-C", str(tmp_path), "config", "user.name", "Bob"], check=True
    )
    subprocess.run(
        ["git", "-C", str(tmp_path), "config", "user.email", "bob@example.com"],
        check=True,
    )
    assert identity.person(tmp_path) == {"name": "Bob", "email": "bob@example.com"}


def test_without_git_or_a_readable_vault_nobody_is_named(tmp_path, monkeypatch):
    monkeypatch.undo()
    from brain import sync

    assert identity.person(tmp_path / "missing") == {"name": "", "email": ""}
    monkeypatch.setattr(sync, "git_available", lambda: False)
    assert identity.person(tmp_path) == {"name": "", "email": ""}


# --------------------------------------------------------------------------- #
# Cooldown and escalation
# --------------------------------------------------------------------------- #


def _decided_then_contradicted_again(root: Path) -> tuple[str, str]:
    ours, theirs = _contradicting_pair(root)
    arbitration.review_pull(root, [theirs], [])
    [pair] = arbitration.open_conflicts(root)
    arbitration.resolve(root, pair["id"], "a")
    # The teammate writes the same advice again, at the same place.
    put(root, theirs, "Never run the migrations before the tests, really.", pinned=True)
    return ours, theirs


def test_a_pair_that_flip_flops_is_escalated_not_settled_again(tmp_path):
    ours, theirs = _decided_then_contradicted_again(tmp_path)

    summary = arbitration.review_pull(tmp_path, [theirs], [])

    # The pinned rule would have settled it: the cooldown wins.
    assert summary == {"checked": 1, "auto": 0, "queued": 1}
    [pair] = arbitration.open_conflicts(tmp_path)
    assert pair["escalated"]["by"] == "Alice Martin"
    assert pair["escalated"]["reason_code"] == "person-chose"
    assert journal.read(tmp_path, BASE)[0].reason_code == "escalated"


def test_after_the_cooldown_the_rules_apply_again(tmp_path, monkeypatch):
    ours, theirs = _decided_then_contradicted_again(tmp_path)
    later = datetime.now(UTC) + timedelta(days=8)
    assert arbitration.earlier_decision(tmp_path, BASE, ours, theirs, now=later) is None
    monkeypatch.setenv("BRAIN_CONFLICT_COOLDOWN_DAYS", "nope")
    assert arbitration.earlier_decision(tmp_path, BASE, ours, theirs) is not None


def test_a_same_statement_merge_is_not_a_decision_to_flip(tmp_path):
    a = put(tmp_path, gotcha("db"), "Use port 5432.")
    b = put(tmp_path, gotcha("db.conflict-1"), "Use port 5432.")
    arbitration.review_pull(tmp_path, [b], [])
    c = put(tmp_path, gotcha("db.conflict-2"), "Use port 6543.", pinned=True)
    journal.append(
        tmp_path,
        BASE,
        JournalEntry(action="resolve", actor="sync", note=a, related=[c], ts="nope"),
    )
    assert arbitration.earlier_decision(tmp_path, BASE, a, c) is None
    # Not escalated: the pinned rule settles it.
    assert arbitration.review_pull(tmp_path, [], [a])["auto"] == 1


def test_an_escalated_pair_waits_for_a_maintainer(tmp_path, monkeypatch):
    _decided_then_contradicted_again(tmp_path)
    arbitration.review_pull(tmp_path, [gotcha("never")], [])
    [pair] = arbitration.open_conflicts(tmp_path)
    maintainers.write(tmp_path, BASE, ["bob@example.com"])

    refused = arbitration.resolve(tmp_path, pair["id"], "b")
    assert refused == {
        "ok": False,
        "code": "maintainer-only",
        "maintainers": ["bob@example.com"],
    }
    assert arbitration.open_conflicts(tmp_path) == [pair]

    monkeypatch.setattr(
        identity, "person", lambda root: {"name": "Bob", "email": "BOB@example.com"}
    )
    assert arbitration.resolve(tmp_path, pair["id"], "b")["ok"]


# --------------------------------------------------------------------------- #
# Maintainers
# --------------------------------------------------------------------------- #


def test_the_maintainers_are_a_file_of_the_vault_and_a_journal_line(tmp_path):
    assert maintainers.read(tmp_path, BASE) == []
    assert maintainers.allows([], ALICE)
    kept = maintainers.write(
        tmp_path, BASE, [" Alice Martin ", "alice martin", "bob@example.com"]
    )
    assert kept == ["Alice Martin", "bob@example.com"]
    text = (tmp_path / BASE / ".lifecycle" / "maintainers.md").read_text(
        encoding="utf-8"
    )
    assert "- Alice Martin\n- bob@example.com\n" in text
    assert maintainers.read(tmp_path, BASE) == kept
    assert maintainers.allows(kept, ALICE)
    assert not maintainers.allows(kept, {"name": "", "email": ""})
    entry = journal.read(tmp_path, BASE)[0]
    assert (
        entry.action == "designate" and entry.reason == "Alice Martin, bob@example.com"
    )


@pytest.mark.parametrize(
    "names",
    [["ok", ""], ["bad\nname"], ["x" * 121], [f"p{n}" for n in range(21)]],
)
def test_a_name_that_is_not_one_writes_nothing(tmp_path, names):
    assert maintainers.write(tmp_path, BASE, names) is None
    assert not (tmp_path / BASE / ".lifecycle" / "maintainers.md").exists()


def test_a_hand_edited_list_keeps_its_readable_names(tmp_path):
    target = tmp_path / BASE / ".lifecycle" / "maintainers.md"
    target.parent.mkdir(parents=True)
    lines = ["# x", "- Alice", "-", "- ", f"- {'y' * 200}", "- tab\there", "not a line"]
    lines += [f"- p{n}" for n in range(30)]
    target.write_text("\n".join(lines), encoding="utf-8")
    names = maintainers.read(tmp_path, BASE)
    assert names[0] == "Alice" and len(names) == maintainers.MAX_MAINTAINERS


# --------------------------------------------------------------------------- #
# Scope
# --------------------------------------------------------------------------- #


def test_a_scoped_memory_no_longer_clashes_with_one_scoped_elsewhere(tmp_path):
    ours, theirs = _contradicting_pair(tmp_path)
    assert store.scope(tmp_path, BASE, ours, "apps/billing/") == {
        "ok": True,
        "applies_to": "apps/billing/",
    }
    store.scope(tmp_path, BASE, theirs, "apps/auth/")
    assert arbitration.review_pull(tmp_path, [theirs], [])["checked"] == 0
    entry = journal.read(tmp_path, BASE)[0]
    assert entry.reason_code == "scoped" and entry.reason == "apps/auth/"

    # Unchanged: nothing journalled; cleared: the key goes.
    count = len(journal.read(tmp_path, BASE))
    store.scope(tmp_path, BASE, ours, "apps/billing/")
    assert len(journal.read(tmp_path, BASE)) == count
    store.scope(tmp_path, BASE, ours, "  ")
    assert "applies_to" not in read_note(tmp_path, ours).meta


def test_a_scope_that_is_not_a_place_is_refused(tmp_path):
    ours, _ = _contradicting_pair(tmp_path)
    assert store.scope(tmp_path, BASE, ours, "x" * 201)["code"] == "invalid"
    assert store.scope(tmp_path, BASE, ours, "a\nb")["code"] == "invalid"
    assert store.scope(tmp_path, BASE, gotcha("gone"), "apps/")["code"] == "not-found"
    with pytest.raises(ValueError):
        store.scope(tmp_path, BASE, "../../etc/passwd", "apps/")
