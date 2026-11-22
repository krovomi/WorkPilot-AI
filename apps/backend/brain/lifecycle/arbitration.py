"""After a sync: the contradictions it brought in, settled or queued.

`sync._pull` reports which notes came from the remote (``received``) and which
ones it kept on both sides (``conflicts``, the ``<name>.conflict-<sha>.md``
copies). `review_pull` looks at the project memory among them:

* a **textual** conflict is two versions of one note;
* a received gotcha or pattern that `contradictions.compare` flags against a
  live note of the same project and kind is a **semantic** one.

Each pair is then settled by the first safe rule that applies — the same
rules on every machine, so two teammates settle a pair the same way:

| Rule | Winner |
|---|---|
| ``same-statement`` | two versions saying the same thing (a learning-loop pattern whose counters drifted): ours, the evidence merged |
| ``pinned-wins`` | the pinned one, when only one is |
| ``higher-confidence`` | two learning-loop patterns ``CONFIDENCE_GAP`` apart: the more confident |
| ``more-recent`` | two different notes, the older not touched for ``BRAIN_CONFLICT_STALE_DAYS`` days (30) before the newer: the newer |

A pair decided less than ``BRAIN_CONFLICT_COOLDOWN_DAYS`` (7) ago — by a
person or a rule — that contradicts again is not settled again: it flip-flops,
so it is queued **escalated**, for a designated maintainer
(`maintainers.py`; anyone when the project names none).

The loser is archived and linked to the winner (`store.archive`). Anything
else waits in the **queue** for a person, who sees both side by side and keeps
one, writes the canonical note (``source: team-consensus-<date>``), or says it
is not a conflict. Every step is journalled.

The queue is this machine's (``.workpilot-brain/conflicts.json``, ignored by
git): two machines flagging the same pair at once would otherwise conflict on
the queue itself. The decision is not: the canonical note, the archived
variants and the journal are in the vault, so a teammate's next sync brings
them, and a queued pair whose notes were settled elsewhere drops out.

No generation model is called here: a sync must work offline and the same
for every provider. A person may ask one for an opinion on a queued pair
(`advisor.py`). An embeddings model already pulled in the local Ollama, when
there is one, finds pairs written in different words (`embeddings.py`); they
are settled or queued like the others, marked ``found_by: embeddings``.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path, PurePosixPath
from typing import Any

from ..memories import redact
from ..notes import Note, inside, now_iso, read_note, slugify, write_note
from . import embeddings, identity, maintainers, scopes
from .contradictions import CHECKED_FOLDERS, compare, find_for, statement
from .journal import JournalEntry, append, preview_of
from .journal import read as read_journal
from .store import FOLDER_KIND, FOLDERS, archive, link_variants, own_text

logger = logging.getLogger(__name__)

__all__ = [
    "CHOICES",
    "CONFIDENCE_GAP",
    "QUEUE_FILE",
    "earlier_decision",
    "open_conflicts",
    "pair_scope",
    "requeue",
    "resolve",
    "review_pull",
    "with_maintainers",
]

QUEUE_FILE = ".workpilot-brain/conflicts.json"
CONFIDENCE_GAP = 0.2
CHOICES = ("a", "b", "custom", "dismiss")
_MAX_CANONICAL = 4000
_DEFAULT_STALE_DAYS = 30
_DEFAULT_COOLDOWN_DAYS = 7
_DECISIONS = ("resolve", "archive")


def _stale_days() -> int:
    try:
        return max(1, int(os.environ.get("BRAIN_CONFLICT_STALE_DAYS", "")))
    except ValueError:
        return _DEFAULT_STALE_DAYS


def _cooldown_days() -> int:
    try:
        return max(1, int(os.environ.get("BRAIN_CONFLICT_COOLDOWN_DAYS", "")))
    except ValueError:
        return _DEFAULT_COOLDOWN_DAYS


def _when(value: Any) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _memory_of(rel: str) -> tuple[str, str] | None:
    """``(base, folder)`` of a project-memory note, or ``None``."""
    parts = PurePosixPath(rel).parts
    if (
        len(parts) >= 6
        and parts[:2] == ("knowledge", "projects")
        and parts[3] == "memory"
        and parts[4] in FOLDERS
        and not any(p.startswith(".") for p in parts)
        and rel.endswith(".md")
    ):
        return "/".join(parts[:4]), parts[4]
    return None


def _original_of(rel: str) -> str | None:
    """``x.md`` for ``x.conflict-<sha>.md``."""
    name = PurePosixPath(rel).name
    if ".conflict-" not in name:
        return None
    stem = name.split(".conflict-", 1)[0]
    return (PurePosixPath(rel).parent / f"{stem}.md").as_posix()


def _note_of(rel: str) -> str:
    return _original_of(rel) or rel


def earlier_decision(
    root: Path, base: str, a_rel: str, b_rel: str, *, now: datetime | None = None
) -> JournalEntry | None:
    """A decision on this same pair within the cooldown: the pair flip-flops.

    Two versions merged because they said the same thing were not a
    decision anyone could overturn, so they do not count.
    """
    since = (now or datetime.now(UTC)) - timedelta(days=_cooldown_days())
    pair = {_note_of(a_rel), _note_of(b_rel)}
    for entry in read_journal(root, base, limit=5000):
        moment = _when(entry.ts)
        if (
            moment is not None
            and moment >= since
            and entry.action in _DECISIONS
            and entry.reason_code != "same-statement"
            and pair <= {_note_of(rel) for rel in (entry.note, *entry.related)}
        ):
            return entry
    return None


def _pair_id(a: str, b: str) -> str:
    joined = "\n".join(sorted((a, b)))
    return hashlib.sha256(joined.encode("utf-8")).hexdigest()[:16]


# -- the queue (this machine's) ------------------------------------------------


def _load(root: Path) -> dict[str, Any]:
    try:
        data = json.loads((root / QUEUE_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    items = data.get("open")
    dismissed = data.get("dismissed")
    return {
        "open": [i for i in items if isinstance(i, dict)]
        if isinstance(items, list)
        else [],
        "dismissed": [str(d) for d in dismissed] if isinstance(dismissed, list) else [],
    }


def _save(root: Path, data: dict[str, Any]) -> None:
    target = root / QUEUE_FILE
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".conflicts-", dir=target.parent)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
    except OSError as exc:
        logger.warning("brain: conflict queue not saved: %s", exc)


def _path_of(item: dict[str, Any], side: str) -> str:
    """The vault path of one side of a queued pair; "" when it has none.

    The queue is a file on this machine that a person may have edited: a side
    that is not an object names no note.
    """
    entry = item.get(side)
    return str(entry.get("path") or "") if isinstance(entry, dict) else ""


def _strings(value: Any) -> list[str]:
    """A frontmatter list as strings; a single value written by hand is one item."""
    if isinstance(value, list):
        return [str(v) for v in value]
    return [str(value)] if value else []


def _exists(root: Path, rel: str) -> bool:
    try:
        return inside(root, rel).is_file()
    except ValueError:
        return False


def open_conflicts(root: Path, base: str | None = None) -> list[dict[str, Any]]:
    """The pairs waiting for a person; those settled elsewhere drop out."""
    data = _load(root)
    live = [
        item
        for item in data["open"]
        if _exists(root, _path_of(item, "a")) and _exists(root, _path_of(item, "b"))
    ]
    if len(live) != len(data["open"]):
        data["open"] = live
        _save(root, data)
    return [item for item in live if base is None or item.get("base") == base]


def pair_scope(root: Path, item: dict[str, Any]) -> str:
    """Where a queued pair applies: the scope its notes share, else the one set.

    Read from the notes, not the queue: a scope written since the pair was
    queued is the one its maintainers are looked up by.
    """
    for side in ("a", "b"):
        try:
            note = read_note(root, _path_of(item, side))
        except (OSError, ValueError):
            continue
        value = scopes.normalise(str(note.meta.get("applies_to") or ""))
        if value:
            return value
    return ""


def with_maintainers(
    root: Path, items: list[dict[str, Any]], who: dict[str, str]
) -> list[dict[str, Any]]:
    """Each escalated pair with who settles it: its scope's maintainers."""
    for item in items:
        escalated = item.get("escalated")
        if not isinstance(escalated, dict):
            continue
        scope = pair_scope(root, item)
        names = maintainers.read(root, str(item.get("base") or ""), scope=scope)
        item["escalated"] = {
            **escalated,
            "scope": scope,
            "maintainers": names,
            "can_arbitrate": maintainers.allows(names, who),
        }
    return items


# -- one pair --------------------------------------------------------------


def _confidence(note: Note) -> float | None:
    learned = note.meta.get("learning")
    if not isinstance(learned, dict):
        return None
    try:
        return float(learned.get("confidence"))
    except (TypeError, ValueError):
        return None


def _side(rel: str, note: Note) -> dict[str, Any]:
    return {
        "path": rel,
        "title": str(note.meta.get("title") or PurePosixPath(rel).stem),
        "text": statement(note.body)[:2000],
        "preview": preview_of(own_text(note.body)),
        "updated": str(note.meta.get("updated") or note.meta.get("created") or ""),
        "pinned": note.meta.get("pinned") is True,
        "confidence": _confidence(note),
        "agents": _strings(note.meta.get("agents"))[:5],
        "tasks": _strings(note.meta.get("tasks"))[:5],
        "applies_to": scopes.normalise(str(note.meta.get("applies_to") or "")) or "",
    }


def _decide(a: Note, b: Note, *, textual: bool) -> tuple[str, str] | None:
    """``("a" | "b", reason_code)`` when a safe rule settles the pair."""
    if textual and statement(a.body).lower() == statement(b.body).lower():
        return "a", "same-statement"
    pa, pb = a.meta.get("pinned") is True, b.meta.get("pinned") is True
    if pa != pb:
        return ("a" if pa else "b"), "pinned-wins"
    ca, cb = _confidence(a), _confidence(b)
    if ca is not None and cb is not None and abs(ca - cb) >= CONFIDENCE_GAP:
        return ("a" if ca > cb else "b"), "higher-confidence"
    if not textual:
        ua = _when(a.meta.get("updated") or a.meta.get("created"))
        ub = _when(b.meta.get("updated") or b.meta.get("created"))
        if ua and ub and abs(ua - ub) >= timedelta(days=_stale_days()):
            return ("a" if ua > ub else "b"), "more-recent"
    return None


def _merge_evidence(ours: dict[str, Any], theirs: dict[str, Any]) -> dict[str, Any]:
    """Two copies of a pattern's evidence: the larger count, every source."""
    merged = dict(ours)
    for key, value in theirs.items():
        mine = merged.get(key)
        if isinstance(value, bool) or isinstance(mine, bool):
            continue
        if isinstance(value, (int, float)) and isinstance(mine, (int, float)):
            merged[key] = max(mine, value)
        elif isinstance(value, list) and isinstance(mine, list):
            merged[key] = list(dict.fromkeys([*mine, *value]))
        elif key not in merged:
            merged[key] = value
    return merged


def _settle(
    root: Path,
    base: str,
    a_rel: str,
    b_rel: str,
    winner: str,
    *,
    textual: bool,
    actor: str,
    reason_code: str,
    reason: str = "",
) -> str:
    """Archive the loser, keep the winner; returns the canonical note's path."""
    win_rel, lose_rel = (a_rel, b_rel) if winner == "a" else (b_rel, a_rel)
    if textual:
        # One note, two versions: the canonical path is the note's own.
        canonical = a_rel
        if winner == "b":
            kept = read_note(root, b_rel)
            archived = archive(
                root,
                base,
                a_rel,
                canonical=canonical,
                actor=actor,
                reason_code=reason_code,
                reason=reason,
            )
            write_note(root, Note(path=Path(a_rel), meta=kept.meta, body=kept.body))
            inside(root, b_rel).unlink()
        else:
            if reason_code == "same-statement":
                ours, theirs = read_note(root, a_rel), read_note(root, b_rel)
                lo, lt = ours.meta.get("learning"), theirs.meta.get("learning")
                if isinstance(lo, dict) and isinstance(lt, dict):
                    ours.meta["learning"] = _merge_evidence(lo, lt)
                    write_note(root, ours)
            archived = archive(
                root,
                base,
                b_rel,
                canonical=canonical,
                actor=actor,
                reason_code=reason_code,
                reason=reason,
            )
    else:
        canonical = win_rel
        archived = archive(
            root,
            base,
            lose_rel,
            canonical=canonical,
            actor=actor,
            reason_code=reason_code,
            reason=reason,
        )
    if archived:
        link_variants(root, canonical, [archived])
    return canonical


def _item(
    pair: str,
    base: str,
    folder: str,
    a: tuple[str, Note],
    b: tuple[str, Note],
    textual: bool,
    signal: str,
    detail: str,
    found_by: str | None = None,
) -> dict[str, Any]:
    """One queued pair, as the Lifecycle tab shows it."""
    marked = {"found_by": found_by} if found_by else {}
    return {
        **marked,
        "id": pair,
        "base": base,
        "project": str(a[1].meta.get("project") or base.split("/")[2]),
        "kind": FOLDER_KIND.get(folder, "note"),
        "signal": signal,
        "detail": detail,
        "textual": textual,
        "detected_at": now_iso(),
        "a": _side(*a),
        "b": _side(*b),
    }


def _consider(
    root: Path,
    data: dict[str, Any],
    base: str,
    folder: str,
    a_rel: str,
    b_rel: str,
    *,
    textual: bool,
    signal: str,
    detail: str,
    summary: dict[str, int],
    found_by: str | None = None,
) -> None:
    pair = _pair_id(a_rel, b_rel)
    if pair in data["dismissed"] or any(i.get("id") == pair for i in data["open"]):
        return
    try:
        a, b = read_note(root, a_rel), read_note(root, b_rel)
    except (OSError, ValueError):
        return
    summary["checked"] += 1
    verdict = _decide(a, b, textual=textual)
    earlier = None
    if verdict is None or verdict[1] != "same-statement":
        earlier = earlier_decision(root, base, a_rel, b_rel)
    if verdict is not None and earlier is None:
        winner, code = verdict
        _settle(
            root,
            base,
            a_rel,
            b_rel,
            winner,
            textual=textual,
            actor="sync",
            reason_code=code,
            reason=detail,
        )
        summary["auto"] += 1
        return
    item = _item(
        pair, base, folder, (a_rel, a), (b_rel, b), textual, signal, detail, found_by
    )
    code = "textual-conflict" if textual else "contradiction-detected"
    if earlier is not None:
        # No rule settles it again: a maintainer does (`maintainers.py`).
        item["escalated"] = {
            "at": earlier.ts,
            "by": earlier.by,
            "actor": earlier.actor,
            "reason_code": earlier.reason_code,
        }
        code = "escalated"
    data["open"].append(item)
    append(
        root,
        base,
        JournalEntry(
            action="conflict",
            actor="sync",
            note=a_rel,
            title=str(a.meta.get("title") or ""),
            preview=preview_of(own_text(a.body)),
            reason_code=code,
            reason=detail,
            related=[b_rel],
        ),
    )
    summary["queued"] += 1


def review_pull(
    root: Path, received: list[str], conflicts: list[str]
) -> dict[str, int]:
    """Settle or queue what a pull brought into the project memories. Never raises."""
    summary = {"checked": 0, "auto": 0, "queued": 0}
    embedder: embeddings.Embedder | None = None
    opened = False
    try:
        data = _load(root)
        textual: dict[tuple[str, str], None] = {}
        for rel in conflicts:
            parent = PurePosixPath(rel).parent
            stem = PurePosixPath(rel).stem
            try:
                folder = inside(root, parent.as_posix())
            except ValueError:
                continue
            for sibling in sorted(folder.glob(f"{stem}.conflict-*.md")):
                textual[(rel, (parent / sibling.name).as_posix())] = None
        for rel in received:
            original = _original_of(rel)
            if original:
                textual[(original, rel)] = None
        for a_rel, b_rel in textual:
            where = _memory_of(a_rel)
            if where and _exists(root, a_rel) and _exists(root, b_rel):
                _consider(
                    root,
                    data,
                    where[0],
                    where[1],
                    a_rel,
                    b_rel,
                    textual=True,
                    signal="textual",
                    detail="",
                    summary=summary,
                )
        for rel in received:
            where = _memory_of(rel)
            if not where or _original_of(rel) or where[1] not in CHECKED_FOLDERS:
                continue
            if not _exists(root, rel):
                continue
            if not opened:  # once a pull brought a note to compare
                embedder, opened = embeddings.open_embedder(root), True
            for other, found in find_for(root, where[0], rel, embedder):
                if not (_exists(root, rel) and _exists(root, other)):
                    break  # settled by an earlier pair of this pull
                _consider(
                    root,
                    data,
                    where[0],
                    where[1],
                    other,
                    rel,
                    textual=False,
                    signal=found.signal,
                    detail=found.detail,
                    summary=summary,
                    found_by=found.found_by,
                )
        _save(root, data)
    except (OSError, ValueError) as exc:
        logger.warning("brain: contradictions after the pull not reviewed: %s", exc)
    finally:
        if embedder is not None:
            embedder.save()
    return summary


def requeue(
    root: Path,
    base: str,
    a_rel: str,
    b_rel: str,
    *,
    textual: bool,
    actor: str = "user",
) -> str | None:
    """Put a pair whose decision a person took back (`undo.revert`) in the queue.

    Taking a decision back is asking for a new one: the pair leaves the
    dismissed list, and its signal is the detector's when it still flags it,
    ``reopened`` otherwise. Returns the pair's id, ``None`` when a side is gone.
    """
    where = _memory_of(a_rel)
    if where is None or not (_exists(root, a_rel) and _exists(root, b_rel)):
        return None
    data = _load(root)
    pair = _pair_id(a_rel, b_rel)
    data["dismissed"] = [d for d in data["dismissed"] if d != pair]
    if not any(i.get("id") == pair for i in data["open"]):
        a, b = read_note(root, a_rel), read_note(root, b_rel)
        found = None if textual else compare(a, b)
        signal = "textual" if textual else (found.signal if found else "reopened")
        data["open"].append(
            _item(
                pair,
                base,
                where[1],
                (a_rel, a),
                (b_rel, b),
                textual,
                signal,
                found.detail if found else "",
            )
        )
        append(
            root,
            base,
            JournalEntry(
                action="conflict",
                actor=actor,
                note=a_rel,
                title=str(a.meta.get("title") or ""),
                preview=preview_of(own_text(a.body)),
                reason_code="textual-conflict" if textual else "contradiction-detected",
                reason=found.detail if found else "",
                related=[b_rel],
            ),
        )
    _save(root, data)
    return pair


# -- a person decides ------------------------------------------------------------


def _free_path(root: Path, base: str, folder: str, title: str) -> str:
    stem = f"consensus-{slugify(title, max_len=50)}"
    for n in range(1, 100):
        name = f"{stem}.md" if n == 1 else f"{stem}-{n}.md"
        rel = f"{base}/{folder}/{name}"
        if not _exists(root, rel):
            return rel
    return f"{base}/{folder}/{stem}-{datetime.now(UTC):%Y%m%d%H%M%S}.md"


def resolve(
    root: Path,
    conflict_id: str,
    choice: str,
    text: str = "",
    *,
    actor: str = "user",
) -> dict[str, Any]:
    """Settle one queued pair. ``code``: ``not-found``, ``stale``, ``invalid``."""
    if choice not in CHOICES:
        return {"ok": False, "code": "invalid"}
    data = _load(root)
    entry = next((i for i in data["open"] if i.get("id") == conflict_id), None)
    if entry is None:
        return {"ok": False, "code": "not-found"}
    base = str(entry.get("base") or "")
    a_rel, b_rel = _path_of(entry, "a"), _path_of(entry, "b")
    a_side = entry["a"] if isinstance(entry.get("a"), dict) else {}
    where = _memory_of(a_rel)
    if (
        not where
        or where[0] != base
        or not (_memory_of(b_rel) or _original_of(b_rel))
        or not b_rel.startswith(f"{base}/")
    ):
        return {"ok": False, "code": "invalid"}
    if isinstance(entry.get("escalated"), dict):
        names = maintainers.read(root, base, scope=pair_scope(root, entry))
        if not maintainers.allows(names, identity.person(root)):
            return {"ok": False, "code": "maintainer-only", "maintainers": names}
    data["open"] = [i for i in data["open"] if i.get("id") != conflict_id]
    if not (_exists(root, a_rel) and _exists(root, b_rel)):
        _save(root, data)
        return {"ok": False, "code": "stale"}
    textual = bool(entry.get("textual"))
    folder = where[1]
    canonical: str | None = None
    if choice in ("a", "b"):
        canonical = _settle(
            root,
            base,
            a_rel,
            b_rel,
            choice,
            textual=textual,
            actor=actor,
            reason_code="person-chose",
        )
        reason_code = "person-chose"
    elif choice == "custom":
        body = redact((text or "").strip())
        if not body or len(body) > _MAX_CANONICAL:
            data["open"].append(entry)
            return {"ok": False, "code": "invalid"}
        a = read_note(root, a_rel)
        title = preview_of(body, 80)
        canonical = a_rel if textual else _free_path(root, base, folder, title)
        variants = [
            archived
            for rel in (a_rel, b_rel)
            if (
                archived := archive(
                    root,
                    base,
                    rel,
                    canonical=canonical,
                    actor=actor,
                    reason_code="person-wrote",
                )
            )
        ]
        kind = FOLDER_KIND.get(folder, "note")
        stamp = now_iso()
        meta = {
            "title": title,
            "kind": "knowledge",
            "memory": kind,
            "project": str(a.meta.get("project") or entry.get("project") or ""),
            "source": f"team-consensus-{stamp[:10]}",
            "variants": variants,
            "tags": ["memory", kind, "team-consensus"],
            "created": stamp,
            "updated": stamp,
        }
        write_note(root, Note(path=Path(canonical), meta=meta, body=body + "\n"))
        append(
            root,
            base,
            JournalEntry(
                action="create",
                actor=actor,
                note=canonical,
                title=title,
                preview=preview_of(body),
                reason_code="person-wrote",
                related=variants,
            ),
        )
        reason_code = "person-wrote"
    else:
        data["dismissed"].append(conflict_id)
        reason_code = "not-a-conflict"
    append(
        root,
        base,
        JournalEntry(
            action="resolve",
            actor=actor,
            note=canonical or a_rel,
            title=str(a_side.get("title") or ""),
            reason_code=reason_code,
            reason=str(entry.get("detail") or ""),
            related=[r for r in (a_rel, b_rel) if r != canonical],
        ),
    )
    _save(root, data)
    return {"ok": True, "canonical": canonical}
