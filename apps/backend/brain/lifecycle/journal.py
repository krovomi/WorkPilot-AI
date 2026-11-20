"""The memory's journal: every lifecycle decision, said in plain words.

A memory that vanished without a word is a memory nobody trusts again. Each
action on a project's memory — created, updated, forgotten, restored, pinned,
merged, archived by a sync arbitration, purged at the end of its retention — is
one line of a Markdown file *inside the vault*, so it travels with the notes to
every teammate and every machine:

    knowledge/projects/<project>/memory/.lifecycle/journal/<YYYY-MM>.md

    - 2026-11-14 10:02 UTC — oubliée par la personne : `gotchas/x.md` « Titre » — Obsolète. <!-- wp-lifecycle {...} -->

The sentence is for the person who opens the file; the comment at the end of
the line carries the same entry as JSON for the app (`read`). Obsidian hides
the comment in reading view.

**One file per month, merged by union.** Two machines appending to the same
file is the one case where git's line merge always conflicts — both add at the
end — and where the right answer is always "keep both lines". The repository's
``.git/info/attributes`` says so (``merge=union``, `sync.ensure_attributes`), and the month
in the name keeps each file small (the issue's rotation).

**The folder is hidden on purpose.** ``.lifecycle/`` starts with a dot, so the
graph, ``brain_recall`` and every memory reader skip it (`notes.iter_notes`):
an agent recalling "what do we know about X" must not be handed the preview of
a memory a person forgot.

**Codes, not prose, decide.** ``action``, ``actor`` and ``reason_code`` come
from closed lists below; the UI translates them. ``reason`` is free text (a
person's words, or a detail such as ``timeout: 30 ≠ 60``), expurgated like
every other text of the vault, and only ever displayed.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from ..memories import redact
from ..notes import inside

logger = logging.getLogger(__name__)

__all__ = [
    "ACTIONS",
    "ACTORS",
    "LIFECYCLE_DIR",
    "REASONS",
    "journal_dir",
    "JournalEntry",
    "append",
    "normalise_actor",
    "preview_of",
    "read",
]

LIFECYCLE_DIR = ".lifecycle"
"""Under a project's ``memory/``: the journal, the forgotten notes, the archive."""

ACTIONS = (
    "create",
    "update",
    "forget",
    "restore",
    "purge",
    "pin",
    "unpin",
    "protect",
    "merge",
    "archive",
    "resolve",
    "conflict",
)

ACTORS = ("user", "agent", "sync", "learning-loop", "lifecycle")
"""Who acted. ``agent:<type>`` (``agent:coder``) narrows ``agent``."""

REASONS = (
    "recorded",
    "edited",
    "user-request",
    "pattern-retired",
    "similar-merged",
    "retention-expired",
    "pinned-protected",
    "restored",
    "pinned",
    "unpinned",
    "pinned-wins",
    "higher-confidence",
    "more-recent",
    "same-statement",
    "contradiction-detected",
    "textual-conflict",
    "person-chose",
    "person-wrote",
    "not-a-conflict",
)

_VERBS = {
    "create": "créée",
    "update": "mise à jour",
    "forget": "oubliée",
    "restore": "restaurée",
    "purge": "supprimée définitivement",
    "pin": "épinglée",
    "unpin": "désépinglée",
    "protect": "protégée (épinglée)",
    "merge": "fusionnée",
    "archive": "archivée",
    "resolve": "conflit résolu",
    "conflict": "conflit détecté",
}
_WHO = {
    "user": "par la personne",
    "agent": "par un agent",
    "sync": "par la synchronisation",
    "learning-loop": "par le learning loop",
    "lifecycle": "par le cycle de vie",
}

_MAX_PREVIEW = 200
_MAX_REASON = 300
_COMMENT = re.compile(r"<!-- wp-lifecycle (\{.*\}) -->\s*$")
_ACTOR = re.compile(r"^agent:[a-z][a-z0-9_-]{0,39}$")


@dataclass
class JournalEntry:
    action: str
    actor: str
    note: str
    """The memory's path in the vault, where it lives (or lived) as a note."""
    title: str = ""
    preview: str = ""
    reason_code: str = "recorded"
    reason: str = ""
    related: list[str] = field(default_factory=list)
    """Other notes the decision involves: sources of a merge, the canonical
    note of an archived variant, the variants of a canonical one."""
    ts: str = ""
    id: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def normalise_actor(actor: str | None) -> str:
    """A known actor, ``agent:<type>``, or ``agent``: never free text."""
    value = (actor or "").strip().lower()
    if value in ACTORS or _ACTOR.fullmatch(value):
        return value
    return "agent"


def preview_of(body: str, limit: int = _MAX_PREVIEW) -> str:
    """The first paragraph of a note's own text, on one line."""
    text = (body or "").strip()
    first = text.split("\n\n", 1)[0]
    line = " ".join(part.strip() for part in first.splitlines() if part.strip())
    line = line.lstrip("#-* ").strip()
    return line if len(line) <= limit else line[: limit - 1].rstrip() + "…"


def _short(text: str, limit: int) -> str:
    one = " ".join((text or "").split())
    one = redact(one)
    return one if len(one) <= limit else one[: limit - 1].rstrip() + "…"


def _sentence(entry: JournalEntry) -> str:
    when = entry.ts.replace("T", " ")[:16] + " UTC"
    who = _WHO.get(entry.actor.split(":", 1)[0], "par un agent")
    if entry.actor.startswith("agent:"):
        who = f"par l'agent {entry.actor.split(':', 1)[1]}"
    rel = entry.note.split("/memory/", 1)[-1]
    title = f" « {entry.title} »" if entry.title else ""
    why = f" — {entry.reason}" if entry.reason else ""
    return f"- {when} — {_VERBS[entry.action]} {who} : `{rel}`{title}{why}"


def journal_dir(root: Path, base: Path | str) -> Path:
    return inside(root, Path(base) / LIFECYCLE_DIR / "journal")


def append(
    root: Path,
    base: Path | str,
    entry: JournalEntry,
    *,
    now: datetime | None = None,
) -> JournalEntry | None:
    """Add *entry* to this month's journal of the memory at *base*.

    A disk that refuses the write is logged and answered with ``None``; only an
    action or reason outside the closed lists raises, as the caller's mistake.
    """
    if entry.action not in ACTIONS:
        raise ValueError(f"unknown lifecycle action {entry.action!r}")
    if entry.reason_code not in REASONS:
        raise ValueError(f"unknown lifecycle reason {entry.reason_code!r}")
    moment = now or datetime.now(UTC)
    entry.ts = entry.ts or moment.isoformat(timespec="seconds")
    entry.id = entry.id or uuid.uuid4().hex[:12]
    entry.actor = normalise_actor(entry.actor)
    entry.title = _short(entry.title, 80)
    entry.preview = _short(entry.preview, _MAX_PREVIEW)
    entry.reason = _short(entry.reason, _MAX_REASON)
    entry.related = [str(r) for r in entry.related][:10]
    # `-->` would close the comment early; `>` escaped is the same JSON.
    payload = json.dumps(entry.to_dict(), ensure_ascii=False).replace(">", "\\u003e")
    line = f"{_sentence(entry)} <!-- wp-lifecycle {payload} -->\n"
    try:
        folder = journal_dir(root, base)
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{moment:%Y-%m}.md"
        with open(path, "a", encoding="utf-8", newline="\n") as handle:
            handle.write(line)
    except (OSError, ValueError) as exc:
        logger.warning("brain: lifecycle journal not written: %s", exc)
        return None
    return entry


def _parse(line: str) -> JournalEntry | None:
    match = _COMMENT.search(line)
    if not match:
        return None
    try:
        data = json.loads(match.group(1))
    except ValueError:
        return None
    if not isinstance(data, dict) or data.get("action") not in ACTIONS:
        return None
    related = data.get("related")
    return JournalEntry(
        action=str(data["action"]),
        actor=normalise_actor(str(data.get("actor") or "")),
        note=str(data.get("note") or ""),
        title=str(data.get("title") or ""),
        preview=str(data.get("preview") or ""),
        reason_code=str(data.get("reason_code") or "recorded"),
        reason=str(data.get("reason") or ""),
        # A line merged from a teammate's vault is text anyone could edit: a
        # `related` that is not a list names no note (a string is not a list
        # of its letters).
        related=[r for r in related if isinstance(r, str)]
        if isinstance(related, list)
        else [],
        ts=str(data.get("ts") or ""),
        id=str(data.get("id") or ""),
    )


def read(
    root: Path,
    base: Path | str,
    *,
    note: str | None = None,
    limit: int = 100,
) -> list[JournalEntry]:
    """The journal, newest first; with *note*, that memory's timeline only."""
    try:
        folder = journal_dir(root, base)
    except ValueError:
        return []
    if not folder.is_dir():
        return []
    found: list[tuple[str, int, JournalEntry]] = []
    seen: set[str] = set()
    # Oldest month first, each file in the order it was written: the order
    # breaks ties between entries of the same second.
    for path in sorted(folder.glob("*.md")):
        try:
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line in lines:
            entry = _parse(line)
            # The same line merged twice (two machines) is one entry; a line
            # without an id has nothing to match and is kept.
            if entry is None or (entry.id and entry.id in seen):
                continue
            if note and entry.note != note and note not in entry.related:
                continue
            seen.add(entry.id)
            found.append((entry.ts, len(found), entry))
    found.sort(key=lambda item: (item[0], item[1]), reverse=True)
    out = [entry for _, _, entry in found]
    return out[: max(1, limit)]
