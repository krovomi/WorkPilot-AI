"""A learning-loop merge, kept so that a person can separate it.

When the learning loop finds a new pattern similar to one it knows
(`PatternStorage.add_patterns`), it folds the new one into the old: more
occurrences, more confidence, its builds and tags added. The folded pattern
was never a note, so the journal could explain the merge but nothing could
take it back. It is now kept, as the note it would have been, in

    knowledge/projects/<project>/memory/.lifecycle/folded/patterns/<id>--<time>.md

with what it brought to the canonical pattern (``lifecycle.share``), and
the journal's ``merge`` entry names it (``related``). **Separate**
(`undo.revert`) puts it back as its own pattern and takes its share out of
the canonical one: its occurrences, the builds and tags only it brought, and
one confidence boost — the boost is the same affine step for every merge, so
removing one gives the confidence the pattern would have without this merge.

A fold is kept `store.retention_days` (30) days: the learning loop merges at
every build, and a merge nobody questioned in a month is the pattern's
history, not a decision to take back. Past that it is deleted without a
journal line: the merge entry stays, the fold was never a memory of its own.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from ..notes import Note, inside, read_note, write_note
from .journal import LIFECYCLE_DIR, JournalEntry
from .store import _iso, _journal, _parse_ts, memory_rel, retention_days

__all__ = ["FOLDED", "keep", "kept", "purge_expired", "unfold"]

FOLDED = "folded"
LEARNED = "learning"
_FOOTER = "confidence {confidence:.2f}, seen {seen}×"


def _folded_dir(base: Path | str) -> PurePosixPath:
    return PurePosixPath(Path(base).as_posix()) / LIFECYCLE_DIR / FOLDED


def _share(value: Any) -> dict[str, Any]:
    share = value if isinstance(value, dict) else {}

    def names(key: str) -> list[str]:
        listed = share.get(key)
        return [str(v) for v in listed][:200] if isinstance(listed, list) else []

    try:
        occurrences = max(0, int(share.get("occurrences") or 0))
        boost = min(0.5, max(0.0, float(share.get("boost") or 0.0)))
    except (TypeError, ValueError):
        occurrences, boost = 0, 0.0
    return {
        "occurrences": occurrences,
        "builds": names("builds"),
        "tags": names("tags"),
        "boost": boost,
    }


def keep(
    root: Path,
    base: Path | str,
    canonical: str,
    note: Note,
    *,
    share: dict[str, Any],
    now: datetime | None = None,
) -> str | None:
    """Keep the folded pattern *note* (its live path, meta and body) beside
    the archive, linked to *canonical*. Returns the kept path, or ``None``
    when either path is not a pattern of this memory."""
    try:
        was = memory_rel(base, note.path.as_posix())
        into = memory_rel(base, canonical)
    except ValueError:
        return None
    # A pattern folded into itself (the same id seen again) is no fold.
    if was == into or not was.startswith(f"{Path(base).as_posix()}/patterns/"):
        return None
    moment = now or datetime.now(UTC)
    rest = PurePosixPath(was).relative_to(PurePosixPath(Path(base).as_posix()))
    stamp = f"{moment:%Y%m%d%H%M%S}-{uuid.uuid4().hex[:6]}"
    target = (_folded_dir(base) / rest.with_name(f"{rest.stem}--{stamp}.md")).as_posix()
    meta = dict(note.meta)
    meta["lifecycle"] = {
        "folded_at": _iso(moment),
        "folded_by": "learning-loop",
        "canonical": into,
        "was": was,
        "restore_until": _iso(moment + timedelta(days=retention_days())),
        "share": _share(share),
    }
    write_note(root, Note(path=Path(target), meta=meta, body=note.body))
    return target


def _info(note: Note) -> dict[str, Any]:
    info = note.meta.get("lifecycle")
    return info if isinstance(info, dict) else {}


def _live_until(note: Note, moment: datetime) -> bool:
    until = _parse_ts(_info(note).get("restore_until"))
    return until is not None and until > moment


def kept(
    root: Path, base: Path | str, entry: JournalEntry, now: datetime | None = None
) -> list[str]:
    """The folds a ``merge`` entry names that can still be separated."""
    moment = now or datetime.now(UTC)
    out = []
    for value in entry.related:
        try:
            rel = memory_rel(base, value, under=FOLDED)
            note = read_note(root, rel)
        except (OSError, ValueError):
            continue
        if _live_until(note, moment):
            out.append(rel)
    return out


def _without(values: Any, taken: list[str]) -> Any:
    if not isinstance(values, list):
        return values
    gone = set(taken)
    return [v for v in values if str(v) not in gone]


def _unshare(root: Path, canonical: str, share: dict[str, Any]) -> None:
    """Take a fold's share out of the canonical pattern's evidence."""
    note = read_note(root, canonical)
    evidence = note.meta.get(LEARNED)
    if not isinstance(evidence, dict):
        return
    try:
        was_seen = int(evidence.get("occurrence_count") or 1)
        was_confidence = float(evidence.get("confidence") or 0.0)
    except (TypeError, ValueError):
        return
    seen = max(1, was_seen - share["occurrences"])
    confidence = was_confidence
    boost = share["boost"]
    if boost and confidence > boost:
        confidence = round((confidence - boost) / (1 - boost), 4)
    evidence["occurrence_count"] = seen
    evidence["confidence"] = confidence
    evidence["source_build_ids"] = _without(
        evidence.get("source_build_ids"), share["builds"]
    )
    evidence["context_tags"] = _without(evidence.get("context_tags"), share["tags"])
    note.meta[LEARNED] = evidence
    # The pattern's own footer says the same figures; the next write of the
    # learning loop rewrites it anyway.
    note.body = note.body.replace(
        _FOOTER.format(confidence=was_confidence, seen=was_seen),
        _FOOTER.format(confidence=confidence, seen=seen),
    )
    write_note(root, note)


def unfold(
    root: Path,
    base: Path | str,
    folds: list[str],
    *,
    actor: str,
    reason_code: str,
    undoes: str,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Put each fold back as its own pattern. ``code``: ``not-found``, ``exists``."""
    moment = now or datetime.now(UTC)
    restored: list[str] = []
    code = "not-found"
    for rel in folds:
        try:
            note = read_note(root, rel)
        except (OSError, ValueError):
            continue
        info = _info(note)
        try:
            was = memory_rel(base, str(info.get("was") or ""))
        except ValueError:
            continue
        if inside(root, was).exists():
            # A pattern of that id came back since: two notes for one id
            # would be read as one by the learning loop.
            code = "exists"
            continue
        meta = {key: value for key, value in note.meta.items() if key != "lifecycle"}
        back = Note(path=Path(was), meta=meta, body=note.body)
        write_note(root, back)
        inside(root, rel).unlink()
        canonical = None
        try:
            canonical = memory_rel(base, str(info.get("canonical") or ""))
        except ValueError:
            pass
        if canonical and inside(root, canonical).is_file():
            _unshare(root, canonical, _share(info.get("share")))
        _journal(
            root,
            base,
            "restore",
            actor,
            was,
            back,
            reason_code=reason_code,
            related=[canonical] if canonical else [],
            undoes=undoes,
            now=moment,
        )
        restored.append(was)
    if not restored:
        return {"ok": False, "code": code}
    return {"ok": True, "restored": restored, "conflict": None}


def purge_expired(root: Path, base: Path | str, *, now: datetime | None = None) -> int:
    """Delete the folds kept past their retention."""
    moment = now or datetime.now(UTC)
    top = inside(root, _folded_dir(base).as_posix())
    if not top.is_dir():
        return 0
    purged = 0
    for path in sorted(top.rglob("*.md")):
        rel = path.relative_to(root).as_posix()
        try:
            note = read_note(root, rel)
        except (OSError, ValueError):
            continue
        if _live_until(note, moment):
            continue
        try:
            path.unlink()
        except OSError:
            continue
        purged += 1
    return purged
