"""Forget, restore, pin, archive: what happens to one memory, and its trace.

``ProjectMemory.forget`` used to ``unlink`` the note: the vault's git history
was the only trace, and nobody reads ``git log`` to find out why the app
stopped knowing something. A forgotten memory now moves, unchanged, to

    knowledge/projects/<project>/memory/.lifecycle/forgotten/<kind>/<slug>.md

with what happened in its frontmatter (``lifecycle:``) and a line in the
journal. It stays there ``BRAIN_MEMORY_RETENTION_DAYS`` days (30), three times
that when it was pinned, and **Restore** puts it back where it was. After
that it is purged — the journal says so too.

**A pin is the person's word against every automation.** ``pinned: true`` in
a note's frontmatter, at most `PIN_LIMIT` per project. An automatic removal
(the learning loop retiring a pattern, a sync arbitration) refuses a pinned
note and journals the refusal (``protect``); only a person forgets it.

**Archived is not forgotten.** A variant a conflict resolution set aside moves
to ``.lifecycle/archived/`` and names its canonical note (``lifecycle.canonical``);
the canonical note lists its ``variants``. No retention: it is the record of
how the team decided.

Every path here comes from a client or a sync and is checked by `memory_rel`
(a kind folder of this project's memory, a ``.md`` file, no hidden or ``..``
segment) before `notes.inside` resolves it.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from ..notes import Note, inside, read_note, slugify, write_note
from .journal import LIFECYCLE_DIR, JournalEntry, append, preview_of

__all__ = [
    "FOLDERS",
    "PIN_LIMIT",
    "archive",
    "forget",
    "iter_live",
    "link_variants",
    "memory_base",
    "memory_rel",
    "own_text",
    "pin",
    "pinned_count",
    "purge_expired",
    "restore",
    "retention_days",
    "trash",
]

FOLDERS = ("gotchas", "patterns", "codebase", "outcomes", "sessions")
"""The kind folders of a project's memory: ``project_memory.KINDS``' values."""

FOLDER_KIND = {
    "gotchas": "gotcha",
    "patterns": "pattern",
    "codebase": "codebase",
    "outcomes": "outcome",
    "sessions": "session",
}

PIN_LIMIT = 50
EXPIRING_DAYS = 7
"""The trash announces what it will purge within this many days."""

_DEFAULT_RETENTION = 30
_PINNED_FACTOR = 3
_LINKS = re.compile(r"\n+## Liens\n.*\Z", re.DOTALL)


def retention_days() -> int:
    try:
        return max(1, int(os.environ.get("BRAIN_MEMORY_RETENTION_DAYS", "")))
    except ValueError:
        return _DEFAULT_RETENTION


def memory_base(project: str) -> Path:
    """``knowledge/projects/<slug>/memory``, relative to the vault."""
    return Path("knowledge") / "projects" / slugify(project) / "memory"


def own_text(body: str) -> str:
    """A note's text without the ``## Liens`` section `Brain.write` appends."""
    return _LINKS.sub("", body or "").strip()


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(UTC)


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _parse_ts(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    try:
        moment = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def memory_rel(base: Path | str, value: str, *, under: str = "") -> str:
    """*value* as a note of the memory at *base*, or ``ValueError``.

    *value* is either the note's vault path (``knowledge/projects/p/memory/
    gotchas/x.md``, what the Memories tab knows a memory by) or its path inside
    *under* (``gotchas/x.md``, a trash or archive id). The first segment must
    be a kind folder, nothing may be hidden or go up, and it is a ``.md``.
    """
    text = str(value or "").strip()
    if not text or "\\" in text or "\0" in text or len(text) > 400:
        raise ValueError("not a memory id")
    prefix = PurePosixPath(Path(base).as_posix())
    if under:
        prefix = prefix / LIFECYCLE_DIR / under
    path = PurePosixPath(text)
    if path.is_absolute():
        raise ValueError("not a memory id")
    try:
        rest = path.relative_to(prefix)
    except ValueError:
        rest = path
    parts = rest.parts
    if (
        len(parts) < 2
        or parts[0] not in FOLDERS
        or any(p in ("", ".", "..") or p.startswith(".") for p in parts)
        or rest.suffix != ".md"
    ):
        raise ValueError("not a memory id")
    return (prefix / rest).as_posix()


def _remainder(base: Path | str, rel: str, under: str = "") -> str:
    prefix = PurePosixPath(Path(base).as_posix())
    if under:
        prefix = prefix / LIFECYCLE_DIR / under
    return PurePosixPath(rel).relative_to(prefix).as_posix()


def _journal(
    root: Path,
    base: Path | str,
    action: str,
    actor: str,
    rel: str,
    note: Note | None,
    *,
    reason_code: str,
    reason: str = "",
    related: list[str] | None = None,
    now: datetime | None = None,
) -> None:
    title = str(note.meta.get("title") or "") if note else ""
    append(
        root,
        base,
        JournalEntry(
            action=action,
            actor=actor,
            note=rel,
            title=title,
            preview=preview_of(own_text(note.body)) if note else "",
            reason_code=reason_code,
            reason=reason,
            related=list(related or []),
        ),
        now=now,
    )


def iter_live(
    root: Path, base: Path | str, folders: tuple[str, ...] = FOLDERS
) -> Iterator[tuple[str, Note]]:
    """The live notes of the memory at *base* (no conflict copies, nothing hidden)."""
    for folder in folders:
        try:
            top = inside(root, Path(base) / folder)
        except ValueError:
            continue
        if not top.is_dir():
            continue
        for path in sorted(top.rglob("*.md")):
            rel_parts = path.relative_to(top).parts
            if any(p.startswith(".") for p in rel_parts) or ".conflict-" in path.name:
                continue
            rel = path.relative_to(root).as_posix()
            try:
                yield rel, read_note(root, rel)
            except (OSError, ValueError):
                continue


# -- pin ---------------------------------------------------------------------


def pinned_count(root: Path, base: Path | str) -> int:
    return sum(
        1 for _, note in iter_live(root, base) if note.meta.get("pinned") is True
    )


def pin(
    root: Path,
    base: Path | str,
    memory_id: str,
    pinned: bool,
    *,
    actor: str = "user",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Pin or unpin one memory. ``code``: ``not-found``, ``pin-limit``."""
    rel = memory_rel(base, memory_id)
    path = inside(root, rel)
    if not path.is_file():
        return {"ok": False, "code": "not-found"}
    note = read_note(root, rel)
    already = note.meta.get("pinned") is True
    if pinned and not already and pinned_count(root, base) >= PIN_LIMIT:
        return {"ok": False, "code": "pin-limit", "limit": PIN_LIMIT}
    if pinned != already:
        moment = _now(now)
        if pinned:
            note.meta["pinned"] = True
            note.meta["pinned_at"] = _iso(moment)
        else:
            for key in ("pinned", "pinned_at"):
                note.meta.pop(key, None)
        write_note(root, note)
        _journal(
            root,
            base,
            "pin" if pinned else "unpin",
            actor,
            rel,
            note,
            reason_code="pinned" if pinned else "unpinned",
            now=moment,
        )
    return {"ok": True, "pinned": pinned, "count": pinned_count(root, base)}


# -- forget / trash / restore ------------------------------------------------


def forget(
    root: Path,
    base: Path | str,
    memory_id: str,
    *,
    actor: str,
    reason_code: str = "user-request",
    reason: str = "",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Move one memory to the trash. ``code``: ``not-found``, ``pinned``.

    A pinned note refuses any actor but the person, and the refusal is
    journalled: the pin won, and the person can see that it had to.
    """
    rel = memory_rel(base, memory_id)
    path = inside(root, rel)
    if not path.is_file():
        return {"ok": False, "code": "not-found"}
    note = read_note(root, rel)
    moment = _now(now)
    was_pinned = note.meta.get("pinned") is True
    if was_pinned and actor != "user":
        _journal(
            root,
            base,
            "protect",
            actor,
            rel,
            note,
            reason_code="pinned-protected",
            reason=reason,
            now=moment,
        )
        return {"ok": False, "code": "pinned"}
    days = retention_days() * (_PINNED_FACTOR if was_pinned else 1)
    trash_rel = (
        PurePosixPath(Path(base).as_posix())
        / LIFECYCLE_DIR
        / "forgotten"
        / _remainder(base, rel)
    ).as_posix()
    meta = dict(note.meta)
    meta["lifecycle"] = {
        "forgotten_at": _iso(moment),
        "forgotten_by": actor,
        "reason_code": reason_code,
        "reason": reason,
        "restore_until": _iso(moment + timedelta(days=days)),
    }
    write_note(root, Note(path=Path(trash_rel), meta=meta, body=note.body))
    path.unlink()
    _journal(
        root,
        base,
        "forget",
        actor,
        rel,
        note,
        reason_code=reason_code,
        reason=reason,
        now=moment,
    )
    return {
        "ok": True,
        "trash_id": _remainder(base, rel),
        "restore_until": meta["lifecycle"]["restore_until"],
    }


def _trash_notes(root: Path, base: Path | str) -> Iterator[tuple[str, Note]]:
    try:
        top = inside(root, Path(base) / LIFECYCLE_DIR / "forgotten")
    except ValueError:
        return
    if not top.is_dir():
        return
    for path in sorted(top.rglob("*.md")):
        rel = path.relative_to(root).as_posix()
        try:
            yield rel, read_note(root, rel)
        except (OSError, ValueError):
            continue


def trash(
    root: Path, base: Path | str, *, now: datetime | None = None
) -> list[dict[str, Any]]:
    """The forgotten memories still restorable, the soonest purged first."""
    moment = _now(now)
    out = []
    for rel, note in _trash_notes(root, base):
        info = note.meta.get("lifecycle") or {}
        until = _parse_ts(info.get("restore_until"))
        trash_id = _remainder(base, rel, "forgotten")
        out.append(
            {
                "id": trash_id,
                "path": (PurePosixPath(Path(base).as_posix()) / trash_id).as_posix(),
                "kind": FOLDER_KIND.get(trash_id.split("/", 1)[0], "note"),
                "title": str(note.meta.get("title") or ""),
                "preview": preview_of(own_text(note.body)),
                "forgotten_at": str(info.get("forgotten_at") or ""),
                "forgotten_by": str(info.get("forgotten_by") or ""),
                "reason_code": str(info.get("reason_code") or ""),
                "reason": str(info.get("reason") or ""),
                "restore_until": str(info.get("restore_until") or ""),
                "pinned": note.meta.get("pinned") is True,
                "expiring_soon": bool(
                    until and until - moment <= timedelta(days=EXPIRING_DAYS)
                ),
            }
        )
    out.sort(key=lambda item: item["restore_until"])
    return out


def purge_expired(root: Path, base: Path | str, *, now: datetime | None = None) -> int:
    """Delete the forgotten memories past their retention; each one journalled."""
    moment = _now(now)
    purged = 0
    for rel, note in list(_trash_notes(root, base)):
        info = note.meta.get("lifecycle") or {}
        until = _parse_ts(info.get("restore_until"))
        if until is None or until > moment:
            continue
        try:
            inside(root, rel).unlink()
        except OSError:
            continue
        purged += 1
        live = (
            PurePosixPath(Path(base).as_posix()) / _remainder(base, rel, "forgotten")
        ).as_posix()
        _journal(
            root,
            base,
            "purge",
            "lifecycle",
            live,
            note,
            reason_code="retention-expired",
            now=moment,
        )
    return purged


def restore(
    root: Path,
    base: Path | str,
    trash_id: str,
    *,
    actor: str = "user",
    now: datetime | None = None,
) -> dict[str, Any]:
    """Put a forgotten memory back. ``code``: ``not-found``, ``exists``, ``expired``.

    ``contradicts`` lists the live notes the restored one disagrees with
    (`contradictions.find_for`): restoring a memory the team has since
    replaced deserves a warning, not a silence.
    """
    trash_rel = memory_rel(base, trash_id, under="forgotten")
    remainder = _remainder(base, trash_rel, "forgotten")
    live = (PurePosixPath(Path(base).as_posix()) / remainder).as_posix()
    source = inside(root, trash_rel)
    if not source.is_file():
        return {"ok": False, "code": "not-found"}
    moment = _now(now)
    note = read_note(root, trash_rel)
    until = _parse_ts((note.meta.get("lifecycle") or {}).get("restore_until"))
    if until is not None and until <= moment:
        return {"ok": False, "code": "expired"}
    if inside(root, live).exists():
        return {"ok": False, "code": "exists", "path": live}
    meta = dict(note.meta)
    meta.pop("lifecycle", None)
    restored = Note(path=Path(live), meta=meta, body=note.body)
    write_note(root, restored)
    source.unlink()
    _journal(
        root, base, "restore", actor, live, restored, reason_code="restored", now=moment
    )
    from .contradictions import find_for

    clashes = find_for(root, base, live)
    return {
        "ok": True,
        "path": live,
        "contradicts": [
            {"path": rel, "signal": c.signal, "detail": c.detail} for rel, c in clashes
        ],
    }


# -- archive -----------------------------------------------------------------


def archive(
    root: Path,
    base: Path | str,
    rel: str,
    *,
    canonical: str,
    actor: str,
    reason_code: str,
    reason: str = "",
    now: datetime | None = None,
) -> str | None:
    """Set a variant aside under ``.lifecycle/archived/``, linked to *canonical*.

    *rel* may be a conflict copy (``x.conflict-<sha>.md``): it is a variant
    like any other. The archived name carries the time, so a note archived
    twice keeps both records. Returns the archived path.
    """
    path = inside(root, rel)
    if not path.is_file():
        return None
    moment = _now(now)
    note = read_note(root, rel)
    rest = PurePosixPath(_remainder(base, rel))
    stamped = rest.with_name(f"{rest.stem}--{moment:%Y%m%d%H%M%S}{rest.suffix}")
    target = (
        PurePosixPath(Path(base).as_posix()) / LIFECYCLE_DIR / "archived" / stamped
    ).as_posix()
    meta = dict(note.meta)
    meta["lifecycle"] = {
        "archived_at": _iso(moment),
        "archived_by": actor,
        "reason_code": reason_code,
        "reason": reason,
        "canonical": canonical,
        "was": rel,
    }
    write_note(root, Note(path=Path(target), meta=meta, body=note.body))
    path.unlink()
    _journal(
        root,
        base,
        "archive",
        actor,
        rel,
        note,
        reason_code=reason_code,
        reason=reason,
        related=[canonical, target],
        now=moment,
    )
    return target


def link_variants(root: Path, canonical: str, variants: list[str]) -> None:
    """Name the archived *variants* in the canonical note's frontmatter."""
    try:
        note = read_note(root, canonical)
    except (OSError, ValueError):
        return
    known = [str(v) for v in note.meta.get("variants") or []]
    note.meta["variants"] = list(dict.fromkeys([*known, *variants]))
    write_note(root, note)
