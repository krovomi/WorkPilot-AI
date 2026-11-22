"""Take a decision on a memory back: the last automatic one, or a merge.

The journal says why a memory went; this module lets a person answer "no".

| Journal entry | Taken back how | Offered |
|---|---|---|
| ``forget`` by an automation (an agent, the learning loop) | the note comes back from the trash | within `UNDO_WINDOW` (1 h): **Undo** |
| ``archive`` by an automation (a sync arbitration) | the variant comes back and the pair waits for a person | within the hour: **Undo** |
| ``archive``, whoever decided | the same, at any time | while the variant is in the archive: **Separate** |
| ``merge`` of two learning-loop patterns | the folded pattern comes back as its own, its share taken out of the other (`folds.py`) | within the hour: **Undo**; then while the fold is kept (30 days): **Separate** |

**Separate** is the issue's manual un-merge. A team-consensus note — the one
a person wrote from two variants — is separated whole: it goes to the trash
(restorable), both variants come back, and the pair waits for a person again.
Any other canonical note stays; the variant comes back beside it and the pair
is queued (`arbitration.requeue`), since the two still disagree.

What cannot be taken back: a person's own forget is restored from the trash,
not undone here; a purge deleted the note; a learning-loop merge older than
its fold's retention, or made before folds were kept.

Each step is journalled (``restore``, reason ``undone`` or ``unmerged``) with
the id of the entry it takes back (``undoes``), so an entry is taken back once.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from ..notes import Note, inside, read_note, write_note
from . import folds, journal
from .arbitration import requeue
from .journal import LIFECYCLE_DIR, JournalEntry
from .store import _journal, forget, memory_rel, restore

__all__ = ["UNDO_WINDOW", "last_undo", "revert", "revertible", "unarchive"]

UNDO_WINDOW = timedelta(hours=1)
_SCAN = 5000
"""Journal entries read to find the one taken back: every month of a project."""


def _when(value: str) -> datetime | None:
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _recent_automatic(entry: JournalEntry, now: datetime) -> bool:
    moment = _when(entry.ts)
    return entry.actor != "user" and moment is not None and now - moment <= UNDO_WINDOW


def _is_file(root: Path, rel: str) -> bool:
    """*rel* has been through `memory_rel` (or is a name made beside one)."""
    return inside(root, rel).is_file()


def _archived_of(base: Path | str, entry: JournalEntry) -> str | None:
    """The archived copy an ``archive`` entry made (one of its ``related``)."""
    for rel in entry.related:
        try:
            return memory_rel(base, rel, under="archived")
        except ValueError:
            continue
    return None


def _trash_of(root: Path, base: Path | str, entry: JournalEntry) -> str | None:
    """The trash id of the note a ``forget`` entry moved, while it is that forget's."""
    try:
        rel = memory_rel(base, entry.note)
    except ValueError:
        return None
    trash_id = PurePosixPath(rel).relative_to(Path(base).as_posix()).as_posix()
    trashed = (
        PurePosixPath(Path(base).as_posix()) / LIFECYCLE_DIR / "forgotten" / trash_id
    )
    try:
        info = read_note(root, trashed.as_posix()).meta.get("lifecycle")
    except (OSError, ValueError):
        return None
    # The same note forgotten again since is another decision.
    if not isinstance(info, dict) or info.get("forgotten_at") != entry.ts:
        return None
    return trash_id


def _candidates(
    root: Path, base: Path | str, entries: list[JournalEntry], now: datetime
) -> dict[str, tuple[str, str]]:
    """Entry id → (mode, what to bring back: an archived path or a trash id)."""
    done = {entry.undoes for entry in entries if entry.undoes}
    out: dict[str, tuple[str, str]] = {}
    for entry in entries:
        if not entry.id or entry.id in done:
            continue
        recent = _recent_automatic(entry, now)
        if entry.action == "archive":
            archived = _archived_of(base, entry)
            if archived and _is_file(root, archived):
                out[entry.id] = ("undo" if recent else "unmerge", archived)
        elif entry.action == "merge":
            kept = folds.kept(root, base, entry, now)
            if kept:
                out[entry.id] = ("undo" if recent else "unmerge", kept[0])
        elif entry.action == "forget" and recent:
            trash_id = _trash_of(root, base, entry)
            if trash_id:
                out[entry.id] = ("undo", trash_id)
    return out


def revertible(
    root: Path,
    base: Path | str,
    entries: list[JournalEntry],
    *,
    now: datetime | None = None,
) -> dict[str, str]:
    """Entry id → ``undo`` or ``unmerge``, for the entries a person can take back."""
    found = _candidates(root, base, entries, now or datetime.now(UTC))
    return {entry_id: mode for entry_id, (mode, _) in found.items()}


def last_undo(entries: list[JournalEntry], modes: dict[str, str]) -> str | None:
    """The newest automatic decision of the last hour still undoable."""
    return next((e.id for e in entries if modes.get(e.id) == "undo"), None)


def _beside(was: str) -> str:
    """A conflict-copy name next to *was*, whose place is taken again."""
    path = PurePosixPath(was)
    stem = path.stem.split(".conflict-", 1)[0]
    return (path.parent / f"{stem}.conflict-undo-{uuid.uuid4().hex[:8]}.md").as_posix()


def _info(note: Note) -> dict[str, Any]:
    """The note's ``lifecycle`` record; empty when a hand edit left another shape."""
    info = note.meta.get("lifecycle")
    return info if isinstance(info, dict) else {}


def _drop_variant(root: Path, canonical: str, archived: str) -> None:
    note = read_note(root, canonical)
    listed = note.meta.get("variants")
    if isinstance(listed, list) and archived in listed:
        note.meta["variants"] = [v for v in listed if v != archived]
        write_note(root, note)


def _live(base: Path | str, value: Any) -> str | None:
    try:
        return memory_rel(base, str(value or ""))
    except ValueError:
        return None


def unarchive(
    root: Path,
    base: Path | str,
    archived: str,
    *,
    actor: str,
    reason_code: str,
    undoes: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Put an archived variant back where it was. ``code``: ``not-found``, ``invalid``.

    Where it was may be taken again (a textual pair whose other version took
    the note's place): it then comes back as a conflict copy beside it.
    """
    if not _is_file(root, archived):
        return {"ok": False, "code": "not-found"}
    moment = now or datetime.now(UTC)
    note = read_note(root, archived)
    info = _info(note)
    was = _live(base, info.get("was"))
    if was is None:
        return {"ok": False, "code": "invalid"}
    target = was if not inside(root, was).exists() else _beside(was)
    meta = {key: value for key, value in note.meta.items() if key != "lifecycle"}
    restored = Note(path=Path(target), meta=meta, body=note.body)
    write_note(root, restored)
    inside(root, archived).unlink()
    canonical = _live(base, info.get("canonical"))
    if canonical and _is_file(root, canonical):
        _drop_variant(root, canonical, archived)
    _journal(
        root,
        base,
        "restore",
        actor,
        target,
        restored,
        reason_code=reason_code,
        related=[canonical] if canonical else [],
        undoes=undoes,
        now=moment,
    )
    return {"ok": True, "path": target, "canonical": canonical}


def _is_consensus(root: Path, rel: str) -> bool:
    source = read_note(root, rel).meta.get("source")
    return str(source or "").startswith("team-consensus-")


def _variants(root: Path, base: Path | str, canonical: str) -> list[str]:
    listed = read_note(root, canonical).meta.get("variants")
    out = []
    for value in listed if isinstance(listed, list) else []:
        try:
            rel = memory_rel(base, str(value), under="archived")
        except ValueError:
            continue
        if _is_file(root, rel):
            out.append(rel)
    return out


def _is_copy(rel: str) -> bool:
    return ".conflict-" in PurePosixPath(rel).name


def _separate(
    root: Path,
    base: Path | str,
    entry: JournalEntry,
    archived: str,
    *,
    actor: str,
    reason_code: str,
    now: datetime | None,
) -> dict[str, Any]:
    canonical = _live(base, _info(read_note(root, archived)).get("canonical"))
    alive = bool(canonical and _is_file(root, canonical))
    variants = [archived]
    if alive and canonical and _is_consensus(root, canonical):
        variants = list(dict.fromkeys([archived, *_variants(root, base, canonical)]))
        # The consensus goes first: a textual pair's note gets its place back.
        forget(root, base, canonical, actor=actor, reason_code=reason_code, now=now)
        alive = False
    targets = []
    for rel in variants:
        outcome = unarchive(
            root,
            base,
            rel,
            actor=actor,
            reason_code=reason_code,
            undoes=entry.id if rel == archived else "",
            now=now,
        )
        if outcome["ok"]:
            targets.append(str(outcome["path"]))
    pair = [canonical, *targets] if alive and canonical else targets
    pair.sort(key=_is_copy)  # a conflict copy is the B side of its note
    conflict = None
    if len(pair) >= 2:
        conflict = requeue(
            root,
            Path(base).as_posix(),
            pair[0],
            pair[1],
            textual=any(_is_copy(rel) for rel in pair[:2]),
            actor=actor,
        )
    return {"ok": bool(targets), "restored": targets, "conflict": conflict}


def revert(
    root: Path,
    base: Path | str,
    entry_id: str,
    *,
    actor: str = "user",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Take one journal entry back. ``code``: ``not-found``, ``not-revertible``."""
    moment = now or datetime.now(UTC)
    entries = journal.read(root, base, limit=_SCAN)
    entry = next((e for e in entries if e.id == entry_id), None)
    if entry is None:
        return {"ok": False, "code": "not-found"}
    found = _candidates(root, base, entries, moment).get(entry.id)
    if found is None:
        return {"ok": False, "code": "not-revertible"}
    mode, what = found
    reason_code = "undone" if mode == "undo" else "unmerged"
    if entry.action == "forget":
        outcome = restore(
            root,
            base,
            what,
            actor=actor,
            reason_code=reason_code,
            undoes=entry.id,
            now=moment,
        )
        outcome["restored"] = [outcome["path"]] if outcome["ok"] else []
    elif entry.action == "merge":
        outcome = folds.unfold(
            root,
            base,
            folds.kept(root, base, entry, moment),
            actor=actor,
            reason_code=reason_code,
            undoes=entry.id,
            now=moment,
        )
    else:
        outcome = _separate(
            root, base, entry, what, actor=actor, reason_code=reason_code, now=moment
        )
    return {**outcome, "mode": mode}
