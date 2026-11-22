"""Team and branch scopes, maintainers per scope, the consensus figures (#352).

* ``applies_to`` names a module, a team (``team:x``) or a git branch
  (``branch:y``); two notes with different scopes never clash;
* ``maintainers.md`` has a list per scope, and the most specific section
  covering a pair's scope says who settles it once it is escalated;
* the lifecycle counts the consensus notes written in 30 days and how many
  still stand.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from brain.lifecycle import (
    arbitration,
    identity,
    journal,
    maintainers,
    metrics,
    scopes,
    store,
)
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


# --------------------------------------------------------------------------- #
# The scope grammar
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "stored"),
    [
        ("", ""),
        ("  apps/billing/ ", "apps/billing/"),
        ("Team: Payments", "team:Payments"),
        ("BRANCH:release/2.0", "branch:release/2.0"),
        ("branch: main", "branch:main"),
        ("docs:intro", "docs:intro"),
    ],
)
def test_a_scope_is_stored_in_one_spelling(raw, stored):
    assert scopes.normalise(raw) == stored


@pytest.mark.parametrize(
    "raw",
    [
        "team:",
        "branch:  ",
        "branch:main feature",
        "branch:a..b",
        "branch:-x",
        "branch:x/",
        "branch:x.lock",
        "branch:a~1",
        "x" * 201,
        "a\nb",
    ],
)
def test_what_is_not_a_scope_is_refused(raw):
    assert scopes.normalise(raw) is None


def test_the_kind_and_the_comparison_key():
    assert [scopes.kind(s) for s in ("", "apps/", "team:x", "branch:y", "a:b")] == [
        "",
        "module",
        "team",
        "branch",
        "module",
    ]
    assert scopes.key("Team: Payments") == scopes.key("team:payments")
    # Unreadable as a scope: compared as written, so it stays apart.
    assert scopes.key("branch:a b") == "branch:a b"


@pytest.mark.parametrize(
    ("section", "scope", "covered"),
    [
        ("apps/", "apps/billing/", True),
        ("apps", "apps/billing", True),
        ("apps/billing/", "apps/billing/", True),
        ("app", "apps/billing/", False),
        ("branch:release/", "branch:release/2.0", True),
        ("team:pay", "team:payments", False),
        ("Team:Payments", "team:payments", True),
        ("team:payments", "apps/", False),
        ("", "apps/", False),
        ("apps/", "", False),
    ],
)
def test_a_section_covers_its_scope_and_what_is_under_it(section, scope, covered):
    assert scopes.covers(section, scope) is covered


def test_team_and_branch_scopes_keep_two_notes_apart(tmp_path):
    ours = put(
        tmp_path, gotcha("always"), "Always run the migrations before the tests."
    )
    theirs = put(
        tmp_path, gotcha("never"), "Never run the migrations before the tests."
    )
    assert store.scope(tmp_path, BASE, ours, "Team: Payments")["applies_to"] == (
        "team:Payments"
    )
    store.scope(tmp_path, BASE, theirs, "branch:release/2.0")
    assert arbitration.review_pull(tmp_path, [theirs], [])["checked"] == 0
    # The same team, spelt differently, is one scope: they clash again.
    store.scope(tmp_path, BASE, theirs, "team:payments")
    assert arbitration.review_pull(tmp_path, [theirs], [])["queued"] == 1
    [pair] = arbitration.open_conflicts(tmp_path)
    assert pair["a"]["applies_to"] == "team:Payments"


def test_a_branch_name_git_would_refuse_is_not_a_scope(tmp_path):
    ours = put(tmp_path, gotcha("always"), "Always lint.")
    assert store.scope(tmp_path, BASE, ours, "branch:my feature") == {
        "ok": False,
        "code": "invalid",
    }
    assert "applies_to" not in read_note(tmp_path, ours).meta


# --------------------------------------------------------------------------- #
# Maintainers per scope
# --------------------------------------------------------------------------- #


def _file(root: Path) -> Path:
    return root / BASE / ".lifecycle" / "maintainers.md"


def test_each_scope_has_its_list_and_the_most_specific_wins(tmp_path):
    maintainers.write(tmp_path, BASE, ["Alice Martin"])
    maintainers.write(tmp_path, BASE, ["Carol"], scope="apps/")
    maintainers.write(tmp_path, BASE, ["Dan"], scope="apps/billing/")
    maintainers.write(tmp_path, BASE, ["Eve"], scope="Team: Payments")

    assert maintainers.read_all(tmp_path, BASE) == {
        "": ["Alice Martin"],
        "apps/": ["Carol"],
        "apps/billing/": ["Dan"],
        "team:Payments": ["Eve"],
    }
    assert maintainers.read(tmp_path, BASE) == ["Alice Martin"]
    assert maintainers.read(tmp_path, BASE, scope="apps/billing/api/") == ["Dan"]
    assert maintainers.read(tmp_path, BASE, scope="apps/auth/") == ["Carol"]
    assert maintainers.read(tmp_path, BASE, scope="team:payments") == ["Eve"]
    assert maintainers.read(tmp_path, BASE, scope="branch:main") == ["Alice Martin"]
    text = _file(tmp_path).read_text(encoding="utf-8")
    assert "\n## apps/billing/\n\n- Dan\n" in text
    entry = journal.read(tmp_path, BASE)[0]
    assert entry.action == "designate" and entry.reason == "team:Payments : Eve"

    # An empty scoped list is gone; the list at the top stays even empty.
    maintainers.write(tmp_path, BASE, [], scope="apps/")
    maintainers.write(tmp_path, BASE, [])
    assert maintainers.read_all(tmp_path, BASE) == {
        "": [],
        "apps/billing/": ["Dan"],
        "team:Payments": ["Eve"],
    }


def test_a_scope_that_is_not_one_writes_nothing(tmp_path):
    assert maintainers.write(tmp_path, BASE, ["Carol"], scope="branch:a b") is None
    assert not _file(tmp_path).exists()


def test_the_sections_are_bounded(tmp_path, monkeypatch):
    monkeypatch.setattr(maintainers, "MAX_SECTIONS", 2)
    assert maintainers.write(tmp_path, BASE, ["A"], scope="a/")
    assert maintainers.write(tmp_path, BASE, ["B"], scope="b/")
    assert maintainers.write(tmp_path, BASE, ["C"], scope="c/") is None
    # A hand edit past the bound: the extra sections are not read.
    _file(tmp_path).write_text("## a/\n- A\n## b/\n- B\n## c/\n- C\n", encoding="utf-8")
    assert set(maintainers.read_all(tmp_path, BASE)) == {"", "a/", "b/"}


def test_a_hand_edited_heading_that_names_no_scope_drops_its_names(tmp_path):
    _file(tmp_path).parent.mkdir(parents=True)
    _file(tmp_path).write_text(
        "- Alice\n\n## branch:a b\n\n- Mallory\n\n## \n- Oscar\n\n## apps/\n\n- Carol\n- "
        + "y" * 200
        + "\n",
        encoding="utf-8",
    )
    assert maintainers.read_all(tmp_path, BASE) == {
        "": ["Alice"],
        "apps/": ["Carol"],
    }


def _escalated(root: Path, scope: str) -> dict:
    ours = put(root, gotcha("always"), "Always run the migrations before the tests.")
    theirs = put(root, gotcha("never"), "Never run the migrations before the tests.")
    store.scope(root, BASE, ours, scope)
    store.scope(root, BASE, theirs, scope)
    arbitration.review_pull(root, [theirs], [])
    [pair] = arbitration.open_conflicts(root)
    arbitration.resolve(root, pair["id"], "a")
    put(
        root,
        theirs,
        "Never run the migrations before the tests, really.",
        applies_to=scope,
    )
    arbitration.review_pull(root, [theirs], [])
    [pair] = arbitration.open_conflicts(root)
    return pair


def test_an_escalated_pair_is_settled_by_its_scopes_maintainers(tmp_path, monkeypatch):
    pair = _escalated(tmp_path, "apps/billing/")
    maintainers.write(tmp_path, BASE, ["Alice Martin"])
    maintainers.write(tmp_path, BASE, ["Bob"], scope="apps/")

    # Alice is a maintainer of the memory, not of apps/.
    refused = arbitration.resolve(tmp_path, pair["id"], "b")
    assert refused["code"] == "maintainer-only" and refused["maintainers"] == ["Bob"]

    [shown] = arbitration.with_maintainers(
        tmp_path, arbitration.open_conflicts(tmp_path), ALICE
    )
    assert shown["escalated"]["scope"] == "apps/billing/"
    assert shown["escalated"]["maintainers"] == ["Bob"]
    assert shown["escalated"]["can_arbitrate"] is False

    monkeypatch.setattr(identity, "person", lambda root: {"name": "Bob", "email": ""})
    assert arbitration.resolve(tmp_path, pair["id"], "b")["ok"]


def test_a_pair_that_is_not_escalated_carries_no_maintainers(tmp_path):
    ours = put(
        tmp_path, gotcha("always"), "Always run the migrations before the tests."
    )
    theirs = put(
        tmp_path, gotcha("never"), "Never run the migrations before the tests."
    )
    arbitration.review_pull(tmp_path, [theirs], [])
    items = arbitration.open_conflicts(tmp_path)
    assert "escalated" not in arbitration.with_maintainers(tmp_path, items, ALICE)[0]
    assert ours


def test_the_scope_of_a_pair_is_read_from_its_notes(tmp_path):
    put(tmp_path, gotcha("a"), "x", applies_to="team:ops")
    put(tmp_path, gotcha("b"), "y")
    item = {"a": {"path": gotcha("gone")}, "b": {"path": gotcha("a")}}
    assert arbitration.pair_scope(tmp_path, item) == "team:ops"
    assert arbitration.pair_scope(tmp_path, {"a": {"path": gotcha("b")}}) == ""
    assert arbitration.pair_scope(tmp_path, {"a": "not a side"}) == ""


# --------------------------------------------------------------------------- #
# The consensus figures
# --------------------------------------------------------------------------- #


def test_consensus_notes_written_this_month_and_still_in_use(tmp_path):
    now = datetime(2026, 11, 20, tzinfo=UTC)
    put(tmp_path, gotcha("one"), "Run them first.", source="team-consensus-2026-11-02")
    put(tmp_path, gotcha("two"), "Lint first.", source="team-consensus-2026-08-02")
    put(tmp_path, gotcha("plain"), "Something else.", source="agent")
    for days, reason in ((3, "person-wrote"), (40, "person-wrote"), (2, "recorded")):
        journal.append(
            tmp_path,
            BASE,
            JournalEntry(
                action="create", actor="user", note=gotcha("x"), reason_code=reason
            ),
            now=now - timedelta(days=days),
        )
    entries = journal.read(tmp_path, BASE, limit=50)
    figures = metrics.compute(tmp_path, BASE, entries, now=now)
    assert figures["consensus_month"] == 1
    assert figures["consensus_live"] == 2
