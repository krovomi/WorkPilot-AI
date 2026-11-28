"""What the builds learn about a project, kept in the vault — the one memory.

WorkPilot used to keep what a build learned in whichever of several stores
happened to be switched on: a Graphiti / LadybugDB graph when
``GRAPHITI_ENABLED`` was set, JSON and Markdown files under
``<spec_dir>/memory/`` otherwise, and the Obsidian vault for everything the
agents wrote themselves. The coder asked Graphiti, the ``get_session_context``
tool read the spec files, the Memories tab read either, the MCP server read the
vault — and a gotcha recorded by one surface was invisible to the next. This
module is the single store they all go through now, and it is the vault.

    <brain>/knowledge/projects/<project>/
      index.md                        the project's hub (`learn._ensure_project`)
      memory/gotchas/<slug>.md        a pitfall, and its fix when known
      memory/patterns/<slug>.md       a convention to follow, and where it applies
      memory/codebase/<slug>.md       what one file of the project is for
      memory/outcomes/<slug>.md       how an approach to a subtask went, and why
      memory/sessions/<spec>/session-NNN-<subtask>.md   what one session did

Every note is an ordinary Obsidian note — frontmatter (``memory:`` names the
kind, ``project:`` the project, ``tasks:`` the Kanban task), a readable body,
``[[links]]`` to the project and the build — so a person reads and edits the
same thing the agents recall, and every other agent connected to the brain
(Claude Code, Codex, hermes…) finds it with ``brain_recall``.

**The API is the one callers already had.** ``ProjectMemory`` answers the
methods of ``GraphitiMemory`` (``save_gotcha``, ``get_patterns_and_gotchas``,
``get_session_history``…), so the coder, the QA fixer, the agent tools and the
runners changed which object they open, not what they ask it.

**The vault exists as soon as something is worth remembering.** Reads never
create anything; the first *write* on a machine without a brain initialises a
local one (`Brain.init()`, no remote — nothing leaves the machine until a
person connects a remote in Settings). A memory that silently fell back to a
second store when the first was absent is exactly how there came to be three.
``BRAIN_ENABLED=false`` turns memory off; it no longer means "remember
elsewhere".

**One sync per session, not per note.** Notes are written with
``Brain.write(sync=False)`` and ``flush()`` — called by ``close()`` — commits,
pulls and pushes once.

**What the agents write is data.** Every note goes through ``trusted=False``
(``knowledge/`` only), and every text through the brain's secret redaction: the
vault has a remote.

**Nothing here can fail a build.** Any error is logged and answered with
``False`` or an empty result, like the Graphiti code it replaces.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import spec_birth
from .lifecycle import announce, provenance, scopes
from .lifecycle import journal as lifecycle_journal
from .lifecycle import store as lifecycle_store
from .memories import redact
from .notes import Note, inside, read_note, slugify
from .runtime import enabled as brain_enabled
from .tasks import project_name, project_name_from, project_rel
from .vault import Brain

logger = logging.getLogger(__name__)

__all__ = [
    "KINDS",
    "LEARNED",
    "LEGACY_FILES",
    "LEGACY_MIGRATED",
    "has_legacy_memory",
    "ProjectMemory",
    "get_graph_hints",
    "import_legacy_spec_memory",
    "is_memory_enabled",
    "agent_memory",
    "list_memories",
    "open_project_memory",
    "search_memories",
]

KINDS: dict[str, str] = {
    "gotcha": "gotchas",
    "pattern": "patterns",
    "codebase": "codebase",
    "outcome": "outcomes",
    "session": "sessions",
}
"""Memory kind -> folder under ``memory/``. Closed, like ``brain.home.KINDS``."""

LEGACY_FILES = ("codebase_map.json", "patterns.md", "gotchas.md", "session_insights")
"""The knowledge the old store kept in ``<spec_dir>/memory/``. The directory also
holds ``services/recovery.py``'s state (``attempt_history.json``,
``build_commits.json``) — execution state, not knowledge — which stays there."""

LEARNED = "learning"
"""Frontmatter key of a pattern the learning loop distilled
(`learning_loop.pattern_storage`): the pattern itself and its evidence —
confidence, occurrences, applications, successes, source builds. Such a note
lives in ``patterns/`` beside the patterns sessions record, and is injected by
the learning loop's own injector, with its confidence gate, never a second
time by the session memory context."""

LEGACY_MIGRATED = "memory.migrated-to-brain"
"""Where the imported ``LEGACY_FILES`` are moved: kept for a person to check,
and no longer at the path any reader used to open."""

_MAX_CONTENT = 500
_MAX_TITLE = 80
_WORD = re.compile(r"[\w-]{3,}", re.UNICODE)
_STOP = frozenset(
    "the and for with that this from into are was were has have not but you your "
    "use using when then than les des une pour dans avec sur est sont pas que qui".split()
)
_init_lock = threading.Lock()


def is_memory_enabled() -> bool:
    """Memory is the brain: on unless ``BRAIN_ENABLED`` (or Settings) turns it off."""
    return brain_enabled()


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _terms(text: str) -> set[str]:
    return {
        w
        for w in (m.group(0).lower() for m in _WORD.finditer(text or ""))
        if w not in _STOP
    }


def _matches(term: str, others: set[str]) -> bool:
    """Exact, or the same word with a different ending (``webhook``/``webhooks``,
    ``handle``/``handler``): a gotcha is written once and asked about in every
    grammatical form a subtask description happens to use."""
    if term in others:
        return True
    if len(term) < 4:
        return False
    return any(
        len(other) >= 4 and (other.startswith(term) or term.startswith(other))
        for other in others
    )


def _score(query_terms: set[str], text: str) -> float:
    """Overlap relative to the shorter side: a ten-word gotcha fully named by a
    two-hundred-word subtask description is a perfect match, not a 5% one."""
    if not query_terms:
        return 0.0
    note_terms = _terms(text)
    if not note_terms:
        return 0.0
    common = sum(1 for term in query_terms if _matches(term, note_terms))
    return min(1.0, common / min(len(query_terms), len(note_terms), 8))


_LINKS = re.compile(r"\n+## Liens\n.*\Z", re.DOTALL)


def _own_text(body: str) -> str:
    """A note's text without the ``## Liens`` section `Brain.write` appends."""
    return _LINKS.sub("", body or "").strip()


def _title(text: str) -> str:
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    line = line.lstrip("#-* ").strip()
    return line if len(line) <= _MAX_TITLE else line[: _MAX_TITLE - 1].rstrip() + "…"


def _items(value: Any) -> list[Any]:
    """The entries of a list a model wrote, which it sometimes writes as one.

    A text read with ``for item in value`` is a list of letters: a session's
    ``"patterns_found": "Use the repository"`` became one note per letter.
    """
    if isinstance(value, (list, tuple)):
        return list(value)
    return [value] if value else []


def _mapping(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(v) for v in value if str(v).strip()]
    return [str(value)] if str(value).strip() else []


def _open_brain(*, create: bool) -> Brain | None:
    """The brain, or ``None`` when it is absent and not asked to create.

    Whether memory is on is the caller's question (`ProjectMemory.is_enabled`).
    """
    brain = Brain()
    if brain.exists:
        return brain
    if not create:
        return None
    with _init_lock:
        if not brain.exists:
            try:
                brain.init()
                logger.info("brain: created a local vault at %s for memory", brain.root)
            except Exception as exc:  # noqa: BLE001 - memory never fails a build
                logger.warning("brain: could not create the vault: %s", exc)
                return None
    return brain if brain.exists else None


class ProjectMemory:
    """One project's memory in the vault, seen from one spec (``spec_dir``).

    Synchronous core (``record_*`` / ``load_*``) for the callers that are
    synchronous, and the ``GraphitiMemory`` async surface on top of it.
    """

    def __init__(
        self,
        spec_dir: Path | str | None = None,
        project_dir: Path | str | None = None,
        *,
        brain: Brain | None = None,
        project: str | None = None,
        actor: str = "agent",
        audience: scopes.Audience | None = None,
        show_unverified: bool = False,
        signatures: bool = True,
    ) -> None:
        self.actor = actor
        """Who the journal says acted (`lifecycle.journal.ACTORS`)."""
        self.audience = audience
        """Whom the reads recall for (`lifecycle.scopes.recalled`): an agent's
        build. ``None`` for a person's surfaces, which show every note."""
        self.show_unverified = show_unverified
        """A person reading: the notes no trusted key signed are kept, marked
        (``verified: False``). Agents never get them (`lifecycle.provenance`)."""
        self.signatures = signatures
        """``False`` for a server project's brain, read by a route: no git
        command runs in a brain that a project's runs write to, and it is
        never synced, so nothing in it came from a teammate."""
        self._unverified: frozenset[str] | None = None
        self._explained: dict[str, tuple[str, str, str, list[str]]] = {}
        self.spec_dir = Path(spec_dir) if spec_dir else None
        self.project_dir = Path(project_dir) if project_dir else None
        if project:
            self.project = project
        elif self.project_dir is not None:
            self.project = project_name(self.project_dir)
        elif self.spec_dir is not None:
            self.project = project_name_from(str(self.spec_dir.resolve()))
        else:
            self.project = ""
        self.spec_id = (
            self.spec_dir.name
            if self.spec_dir is not None and self.spec_dir.parent.name == "specs"
            else ""
        )
        self._brain = brain
        self._pending = 0
        self._pulled = False
        self._imported = False

    def unverified_notes(self) -> frozenset[str]:
        """This project's notes whose last change no trusted key signed.

        Empty when the project lists no trusted signer. Read once per
        memory, after its pull, like the notes themselves.
        """
        if not self.signatures:
            return frozenset()
        if self._unverified is None:
            brain = self._reader()
            self._unverified = (
                provenance.unverified(brain.root, self.base)
                if brain is not None
                else frozenset()
            )
        return self._unverified

    # -- plumbing -----------------------------------------------------------

    @property
    def is_enabled(self) -> bool:
        return is_memory_enabled() and bool(self.project)

    @property
    def is_initialized(self) -> bool:
        return self._get_brain(create=False) is not None

    @property
    def task(self) -> str | None:
        return f"{self.project}/{self.spec_id}" if self.spec_id else None

    @property
    def base(self) -> Path:
        return project_rel(self.project).parent / "memory"

    def _get_brain(self, *, create: bool) -> Brain | None:
        if not self.is_enabled:
            return None
        if self._brain is None:
            self._brain = _open_brain(create=create)
            return self._brain
        # A brain handed in (``--brain-dir``) is the one to use, existing or not:
        # falling back to the default vault would write somewhere else.
        if not self._brain.exists and create:
            try:
                self._brain.init()
            except Exception as exc:  # noqa: BLE001 - memory never fails a build
                logger.warning("brain: could not create the vault: %s", exc)
        return self._brain if self._brain.exists else None

    def _reader(self) -> Brain | None:
        brain = self._get_brain(create=False)
        if brain is None:
            return None
        if not self._pulled:
            self._pulled = True
            if self.project_dir is not None:
                # Which folder this memory is for: a sync of the whole vault
                # finds the project's channels by it (`lifecycle.announce`).
                announce.register_project(brain.root, self.project_dir)
            try:
                brain.before_read()
            except Exception as exc:  # noqa: BLE001 - a failed pull still reads the disk
                logger.debug("brain: pull before a memory read failed: %s", exc)
        self._import_legacy_once(brain)
        return brain

    def _import_legacy_once(self, brain: Brain) -> None:
        if self._imported or self.spec_dir is None:
            return
        self._imported = True
        if has_legacy_memory(self.spec_dir):
            import_legacy_spec_memory(self.spec_dir, self.project_dir, brain=brain)

    def _write(
        self,
        kind: str,
        title: str,
        body: str,
        *,
        slug: str | None = None,
        folder: str | None = None,
        meta: dict[str, Any] | None = None,
        tags: list[str] | None = None,
    ) -> str | None:
        body = redact(body or "").strip()
        title = redact(title or "").strip() or _title(body)
        if not body or not title:
            return None
        brain = self._get_brain(create=True)
        if brain is None:
            return None
        self._import_legacy_once(brain)
        from .learn import _ensure_project

        project_link = _ensure_project(brain.root, self.project)
        rel = self.base / (folder or KINDS[kind]) / f"{slug or slugify(title)}.md"
        before = self._own_text_at(brain, rel)
        fields: dict[str, Any] = {
            "memory": kind,
            "project": self.project,
            **(meta or {}),
        }
        if self.spec_id:
            fields.setdefault("spec", self.spec_id)
        result = brain.write(
            title,
            body,
            tags=["memory", kind, slugify(self.project), *(tags or [])],
            links=[project_link],
            agent="workpilot",
            path=rel.as_posix(),
            trusted=False,
            task=self.task,
            meta=fields,
            sync=False,
        )
        self._pending += 1
        self._journal_write(brain, result.rel, title, body, before)
        return result.rel

    @staticmethod
    def _own_text_at(brain: Brain, rel: Path) -> str | None:
        try:
            return _own_text(read_note(brain.root, rel).body)
        except (OSError, ValueError):
            return None

    def explain_next(
        self,
        kind: str,
        slug: str,
        *,
        action: str,
        reason_code: str,
        reason: str = "",
        related: list[str] | None = None,
    ) -> None:
        """How the journal should word the next write of this note (a merge),
        and the notes it names (the folds a merge kept, `lifecycle.folds`)."""
        self._explained[f"{KINDS[kind]}/{slugify(slug)}"] = (
            action,
            reason_code,
            reason,
            list(related or []),
        )

    def keep_folded(
        self,
        into: str,
        pattern: dict[str, Any],
        *,
        title: str,
        body: str,
        share: dict[str, Any],
    ) -> str | None:
        """Keep a learning-loop pattern folded into the pattern *into*, so that
        a person can separate them (`lifecycle.folds`). Its kept path, or
        ``None`` when there is no brain or the ids are not patterns."""
        from .lifecycle import folds

        brain = self._get_brain(create=False)
        pattern_id = str(pattern.get("pattern_id") or "").strip()
        if brain is None or not pattern_id:
            return None
        kind = KINDS["pattern"]
        evidence = {
            k: (redact(v) if isinstance(v, str) else v)
            for k, v in pattern.items()
            if k != "effectiveness_rate"
        }
        stamp = datetime.now(UTC).isoformat(timespec="seconds")
        note = Note(
            path=self.base / kind / f"{slugify(pattern_id)}.md",
            meta={
                "title": redact(title)[:80],
                "kind": "knowledge",
                "memory": "pattern",
                "project": self.project,
                "tags": ["memory", "pattern", slugify(self.project), "learning-loop"],
                "created": stamp,
                "updated": stamp,
                LEARNED: evidence,
            },
            body=redact(body),
        )
        canonical = (self.base / kind / f"{slugify(into)}.md").as_posix()
        try:
            kept = folds.keep(brain.root, self.base, canonical, note, share=share)
        except (OSError, ValueError) as exc:
            logger.warning("brain: folded pattern not kept: %s", exc)
            return None
        if kept:
            self._pending += 1
        return kept

    def _journal_write(
        self, brain: Brain, rel: str, title: str, body: str, before: str | None
    ) -> None:
        """A creation, or an update whose text changed: counters alone are not news."""
        now = _own_text(body)
        if before is not None and before == now:
            return
        key = rel.split("/memory/", 1)[-1].removesuffix(".md")
        action, code, reason, related = self._explained.pop(
            key,
            ("create", "recorded", "", [])
            if before is None
            else ("update", "edited", "", []),
        )
        lifecycle_journal.append(
            brain.root,
            self.base,
            lifecycle_journal.JournalEntry(
                action=action,
                actor=self.actor,
                note=rel,
                title=title,
                preview=lifecycle_journal.preview_of(now),
                reason_code=code,
                reason=reason,
                related=related,
            ),
        )

    def flush(self) -> bool:
        """Commit, pull and push what this instance wrote. Idempotent."""
        if not self._pending or self._brain is None:
            return True
        count, self._pending = self._pending, 0
        what = f"{self.project}/{self.spec_id}" if self.spec_id else self.project
        try:
            result = self._brain.after_write(f"brain: memory {what} ({count} note(s))")
            return not result.error
        except Exception as exc:  # noqa: BLE001 - the notes are on disk; the next sync takes them
            logger.warning("brain: memory sync failed: %s", exc)
            return False

    def _notes(
        self, kind: str, *, learned: bool | None = None, everything: bool = False
    ) -> list[tuple[str, dict[str, Any], str]]:
        """The notes of *kind*. ``learned`` keeps only the learning loop's
        patterns (``True``) or only the others (``False``); ``None`` keeps all.

        A note no trusted key signed is left out unless a person reads
        (``show_unverified``) or the caller keeps the store whole
        (``everything``: the learning loop rewrites what it read).
        """
        brain = self._reader()
        if brain is None:
            return []
        folder = inside(brain.root, self.base / KINDS[kind])
        if not folder.is_dir():
            return []
        hidden = (
            frozenset()
            if everything or self.show_unverified
            else self.unverified_notes()
        )
        out = []
        for path in sorted(folder.rglob("*.md")):
            if path.name.startswith(".") or ".conflict-" in path.name:
                continue
            rel = path.relative_to(brain.root).as_posix()
            if rel in hidden:
                continue
            try:
                note = read_note(brain.root, rel)
            except (OSError, ValueError):
                continue
            meta = dict(note.meta)
            if learned is not None and isinstance(meta.get(LEARNED), dict) != learned:
                continue
            out.append((rel, meta, _own_text(note.body)))
        return out

    def _recall(
        self, kind: str, *, learned: bool | None = None
    ) -> list[tuple[str, dict[str, Any], str]]:
        """`_notes`, less what `audience` does not recall. The reads go
        through it; a write reads every note (`_notes`), recalled or not."""
        notes = self._notes(kind, learned=learned)
        if self.audience is None:
            return notes
        return [
            n for n in notes if scopes.recalled(n[1].get("applies_to"), self.audience)
        ]

    # -- write (synchronous core) -------------------------------------------

    def record_gotcha(
        self, gotcha: str, *, solution: str = "", trigger: str = "", context: str = ""
    ) -> bool:
        text = (gotcha or "").strip()
        if not text:
            return False
        lines = [text]
        if trigger:
            lines += ["", f"**Quand :** {trigger}"]
        if solution:
            lines += ["", f"**Solution :** {solution}"]
        if context:
            lines += ["", f"_Contexte : {context}_"]
        meta = {k: v for k, v in (("solution", solution), ("trigger", trigger)) if v}
        return (
            self._write("gotcha", _title(text), "\n".join(lines), meta=meta) is not None
        )

    def record_pattern(
        self, pattern: str, *, applies_to: str = "", example: str = ""
    ) -> bool:
        text = (pattern or "").strip()
        if not text:
            return False
        lines = [text]
        if applies_to:
            lines += ["", f"**S'applique à :** {applies_to}"]
        if example:
            lines += ["", "```", example.strip(), "```"]
        meta = {"applies_to": applies_to} if applies_to else {}
        return (
            self._write("pattern", _title(text), "\n".join(lines), meta=meta)
            is not None
        )

    def record_learned_pattern(
        self, pattern: dict[str, Any], *, title: str, body: str
    ) -> str | None:
        """File one learning-loop pattern, its evidence in the frontmatter.

        One note per ``pattern_id``: writing it again updates it in place. The
        texts are expurgated like every other memory, the frontmatter copy too.
        """
        pattern_id = str(pattern.get("pattern_id") or "").strip()
        if not pattern_id:
            return None
        evidence = {
            k: (redact(v) if isinstance(v, str) else v)
            for k, v in pattern.items()
            if k != "effectiveness_rate"
        }
        return self._write(
            "pattern",
            title,
            body,
            slug=slugify(pattern_id),
            meta={LEARNED: evidence},
            tags=["learning-loop"],
        )

    def learned_patterns(self) -> list[dict[str, Any]]:
        """The learning loop's patterns, oldest first, as their dicts."""
        return [
            dict(meta[LEARNED])
            for _, meta, _ in self._by_date(
                self._notes("pattern", learned=True, everything=True)
            )
        ]

    def unrecalled_pattern_ids(self) -> set[str]:
        """The learning loop's patterns this memory's agents do not get: the
        notes no trusted key signed (`lifecycle.provenance`) and those its
        `audience` does not recall (another branch, another team:
        `lifecycle.scopes.recalled`). Kept by the store, which rewrites them
        all; never put in a prompt nor answered by ``mem_search``."""
        hidden = self.unverified_notes()
        if not hidden and self.audience is None:
            return set()
        return {
            str(meta[LEARNED].get("pattern_id") or "")
            for rel, meta, _ in self._notes("pattern", learned=True, everything=True)
            if rel in hidden
            or (
                self.audience is not None
                and not scopes.recalled(meta.get("applies_to"), self.audience)
            )
        }

    def forget(
        self, kind: str, slug: str, *, reason_code: str = "", reason: str = ""
    ) -> bool:
        """Move one note of this project's memory to the trash (`lifecycle.store`).

        Restorable for ``BRAIN_MEMORY_RETENTION_DAYS``, and journalled. A pinned
        note refuses every actor but the person (``False``). ``False`` when absent.
        """
        brain = self._get_brain(create=False)
        if brain is None or kind not in KINDS:
            return False
        rel = (self.base / KINDS[kind] / f"{slugify(slug)}.md").as_posix()
        code = reason_code or (
            "user-request" if self.actor == "user" else "pattern-retired"
        )
        try:
            outcome = lifecycle_store.forget(
                brain.root,
                self.base,
                rel,
                actor=self.actor,
                reason_code=code,
                reason=reason,
            )
        except (OSError, ValueError) as exc:
            logger.warning("brain: memory note not forgotten: %s", exc)
            return False
        if outcome.get("code") == "pinned":
            self._pending += 1  # the refusal is journalled, and syncs
        if not outcome.get("ok"):
            return False
        self._pending += 1
        return True

    def record_discovery(
        self, file_path: str, description: str, *, category: str = "", changes: str = ""
    ) -> bool:
        path = (file_path or "").strip().replace("\\", "/")
        desc = (description or "").strip()
        if not path or not desc:
            return False
        lines = [f"`{path}` — {desc}"]
        if changes:
            lines += ["", f"**Dernière modification :** {changes}"]
        meta: dict[str, Any] = {"file": path}
        if category:
            meta["category"] = category
        return (
            self._write(
                "codebase",
                path,
                "\n".join(lines),
                slug=slugify(path.replace("/", " ").replace(".", " "), max_len=90),
                meta=meta,
            )
            is not None
        )

    def record_outcome(
        self,
        task_id: str,
        success: bool,
        outcome: str,
        metadata: dict[str, Any] | None = None,
    ) -> bool:
        metadata = dict(metadata or {})
        verdict = "réussi" if success else "échoué"
        lines = [f"Sous-tâche `{task_id}` : **{verdict}**.", "", outcome.strip() or "—"]
        for key, label in (
            ("why_worked", "Pourquoi ça a marché"),
            ("why_failed", "Pourquoi ça a échoué"),
        ):
            if metadata.get(key):
                lines += ["", f"**{label} :** {metadata[key]}"]
        tried = _as_list(metadata.get("alternatives_tried"))
        if tried:
            lines += ["", "**Essayé aussi :**", *[f"- {t}" for t in tried]]
        files = _as_list(metadata.get("changed_files"))
        if files:
            lines += ["", "**Fichiers :**", *[f"- `{f}`" for f in files[:25]]]
        slug = slugify(f"{self.spec_id or 'task'} {task_id}")
        return (
            self._write(
                "outcome",
                f"{task_id} — {verdict}",
                "\n".join(lines),
                slug=slug,
                meta={"subtask": task_id, "success": bool(success)},
            )
            is not None
        )

    def record_session(
        self, session_num: int, insights: dict[str, Any], *, label: str = ""
    ) -> bool:
        """One session's insights, and its discoveries filed as their own notes."""
        insights = dict(insights or {})
        discoveries = _mapping(insights.get("discoveries"))
        for path, purpose in _mapping(discoveries.get("files_understood")).items():
            desc = purpose.get("description") if isinstance(purpose, dict) else purpose
            self.record_discovery(str(path), str(desc or ""))
        for pattern in _as_list(discoveries.get("patterns_found")):
            self.record_pattern(pattern)
        for gotcha in _as_list(discoveries.get("gotchas_encountered")):
            self.record_gotcha(gotcha)

        data = {
            "session_number": int(session_num),
            "timestamp": insights.get("timestamp") or _now(),
            "subtasks_completed": _as_list(insights.get("subtasks_completed")),
            "what_worked": _as_list(insights.get("what_worked")),
            "what_failed": _as_list(insights.get("what_failed")),
            "recommendations_for_next_session": _as_list(
                insights.get("recommendations_for_next_session")
            ),
        }
        lines = [f"Session {session_num} de `{self.spec_id or self.project}`."]
        for key, heading in (
            ("subtasks_completed", "Sous-tâches terminées"),
            ("what_worked", "Ce qui a marché"),
            ("what_failed", "Ce qui a échoué"),
            ("recommendations_for_next_session", "Pour la session suivante"),
        ):
            if data[key]:
                lines += ["", f"## {heading}", "", *[f"- {item}" for item in data[key]]]
        spec = self.spec_id or "project"
        # The coder and the QA fixer each number their own sessions from 1:
        # the subtask that ran is part of the name, or one overwrites the other.
        label = label or next(iter(data["subtasks_completed"]), "")
        slug = f"session-{int(session_num):03d}"
        if label:
            slug = f"{slug}-{slugify(label, max_len=40)}"
        return (
            self._write(
                "session",
                f"{spec} — session {int(session_num):03d}"
                + (f" ({label})" if label else ""),
                "\n".join(lines),
                folder=f"{KINDS['session']}/{slugify(spec)}",
                slug=slug,
                meta=data,
            )
            is not None
        )

    def record_structured(self, insights: dict[str, Any]) -> bool:
        """The insight extractor's output, one note per fact."""
        insights = dict(insights or {})
        wrote = False
        for item in _items(insights.get("file_insights")):
            if isinstance(item, dict):
                wrote |= self.record_discovery(
                    str(item.get("path") or ""),
                    str(item.get("purpose") or ""),
                    changes=str(item.get("changes_made") or ""),
                )
        for item in _items(insights.get("patterns_discovered")):
            if isinstance(item, dict):
                wrote |= self.record_pattern(
                    str(item.get("pattern") or ""),
                    applies_to=str(item.get("applies_to") or ""),
                    example=str(item.get("example") or ""),
                )
            else:
                wrote |= self.record_pattern(str(item))
        for item in _items(insights.get("gotchas_discovered")):
            if isinstance(item, dict):
                wrote |= self.record_gotcha(
                    str(item.get("gotcha") or ""),
                    trigger=str(item.get("trigger") or ""),
                    solution=str(item.get("solution") or ""),
                )
            else:
                wrote |= self.record_gotcha(str(item))
        outcome = insights.get("approach_outcome") or {}
        if isinstance(outcome, dict) and outcome:
            wrote |= self.record_outcome(
                str(insights.get("subtask_id") or "unknown"),
                bool(outcome.get("success", insights.get("success", False))),
                str(outcome.get("approach_used") or ""),
                {
                    "why_worked": outcome.get("why_it_worked"),
                    "why_failed": outcome.get("why_it_failed"),
                    "alternatives_tried": outcome.get("alternatives_tried"),
                    "changed_files": insights.get("changed_files"),
                },
            )
        return wrote

    # -- read (synchronous core) --------------------------------------------

    def load_gotchas(self) -> list[str]:
        return [body.strip() for _, _, body in self._by_date(self._recall("gotcha"))]

    def load_patterns(self) -> list[str]:
        return [
            body.strip()
            for _, _, body in self._by_date(self._recall("pattern", learned=False))
        ]

    def load_codebase_map(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for _, meta, body in self._recall("codebase"):
            path = str(meta.get("file") or "")
            if path:
                first = body.strip().splitlines()[0] if body.strip() else ""
                out[path] = first.split(" — ", 1)[-1] if " — " in first else first
        return out

    def load_sessions(self, *, spec_only: bool = True) -> list[dict[str, Any]]:
        sessions = []
        # A spec name is reused when a task is deleted and the next one takes
        # its number: an earlier task's sessions are not this one's history.
        born = spec_birth.born_at(self.spec_dir) if spec_only and self.spec_id else None
        for rel, meta, _ in self._recall("session"):
            if spec_only and self.spec_id and meta.get("spec") != self.spec_id:
                continue
            if spec_birth.predates(meta.get("timestamp"), born):
                continue
            item = {
                k: meta.get(k)
                for k in (
                    "session_number",
                    "timestamp",
                    "subtasks_completed",
                    "what_worked",
                    "what_failed",
                    "recommendations_for_next_session",
                    "spec",
                )
            }
            item["path"] = rel
            sessions.append(item)
        sessions.sort(
            key=lambda s: (str(s.get("spec") or ""), int(s.get("session_number") or 0))
        )
        return sessions

    @staticmethod
    def _by_date(
        notes: list[tuple[str, dict[str, Any], str]],
    ) -> list[tuple[str, dict[str, Any], str]]:
        return sorted(notes, key=lambda n: str(n[1].get("created") or ""))

    def search(
        self,
        query: str,
        *,
        kinds: tuple[str, ...] = tuple(KINDS),
        limit: int = 5,
        min_score: float = 0.0,
        learned: bool | None = None,
    ) -> list[dict[str, Any]]:
        """Notes of this project's memory ranked by overlap with *query*."""
        terms = _terms(query)
        marked = self.unverified_notes() if self.show_unverified else frozenset()
        hits = []
        for kind in kinds:
            for rel, meta, body in self._recall(kind, learned=learned):
                title = str(meta.get("title") or "")
                score = _score(terms, f"{title}\n{body}")
                if terms and score <= 0:
                    continue
                if score < min_score:
                    continue
                hits.append(
                    {
                        "content": f"{title}\n{body.strip()}"[:_MAX_CONTENT],
                        "score": round(score, 3),
                        "type": kind,
                        "path": rel,
                        "meta": meta,
                        "updated": str(
                            meta.get("updated") or meta.get("created") or ""
                        ),
                        "verified": rel not in marked,
                    }
                )
        # Newest first, then (stable) best score first: equal scores keep recency.
        hits.sort(key=lambda h: h["updated"], reverse=True)
        if terms:
            hits.sort(key=lambda h: h["score"], reverse=True)
        return hits[:limit]

    def status(self) -> dict[str, Any]:
        brain = self._get_brain(create=False)
        counts = (
            {kind: len(self._notes(kind, everything=True)) for kind in KINDS}
            if brain
            else {}
        )
        return {
            "enabled": self.is_enabled,
            "initialized": brain is not None,
            "store": "brain",
            "root": str(brain.root) if brain else None,
            "project": self.project,
            "spec": self.spec_id or None,
            "counts": counts,
        }

    # -- the GraphitiMemory surface ------------------------------------------

    async def initialize(self) -> bool:
        return self.is_enabled

    async def close(self) -> None:
        await asyncio.to_thread(self.flush)

    async def save_session_insights(self, session_num: int, insights: dict) -> bool:
        return await self._run(self.record_session, session_num, insights)

    async def save_codebase_discoveries(self, discoveries: dict[str, str]) -> bool:
        def _all() -> bool:
            wrote = False
            for path, desc in (discoveries or {}).items():
                wrote |= self.record_discovery(str(path), str(desc))
            return wrote

        return await self._run(_all)

    async def save_pattern(self, pattern: str) -> bool:
        return await self._run(self.record_pattern, pattern)

    async def save_gotcha(self, gotcha: str) -> bool:
        return await self._run(self.record_gotcha, gotcha)

    async def save_task_outcome(
        self, task_id: str, success: bool, outcome: str, metadata: dict | None = None
    ) -> bool:
        return await self._run(self.record_outcome, task_id, success, outcome, metadata)

    async def save_structured_insights(self, insights: dict) -> bool:
        return await self._run(self.record_structured, insights)

    async def get_relevant_context(
        self, query: str, num_results: int = 5, include_project_context: bool = True
    ) -> list[dict]:
        return await self._read(self.search, query, limit=num_results)

    async def get_session_history(
        self, limit: int = 5, spec_only: bool = True
    ) -> list[dict]:
        def _latest() -> list[dict]:
            sessions = self.load_sessions(spec_only=spec_only)
            return list(reversed(sessions))[:limit]

        return await self._read(_latest)

    async def get_similar_task_outcomes(
        self, task_description: str, limit: int = 5
    ) -> list[dict]:
        def _similar() -> list[dict]:
            out = []
            for hit in self.search(task_description, kinds=("outcome",), limit=limit):
                meta = hit["meta"]
                out.append(
                    {
                        "task_id": meta.get("subtask"),
                        "success": meta.get("success"),
                        "outcome": hit["content"],
                        "score": hit["score"],
                    }
                )
            return out

        return await self._read(_similar)

    async def get_patterns_and_gotchas(
        self, query: str, num_results: int = 5, min_score: float = 0.5
    ) -> tuple[list[dict], list[dict]]:
        def _both() -> tuple[list[dict], list[dict]]:
            patterns = [
                {
                    "pattern": _body_text(h),
                    "applies_to": h["meta"].get("applies_to", ""),
                    "score": h["score"],
                }
                for h in self.search(
                    query,
                    kinds=("pattern",),
                    limit=num_results,
                    min_score=min_score,
                    learned=False,
                )
            ]
            gotchas = [
                {
                    "gotcha": _body_text(h),
                    "solution": h["meta"].get("solution", ""),
                    "score": h["score"],
                }
                for h in self.search(
                    query, kinds=("gotcha",), limit=num_results, min_score=min_score
                )
            ]
            return patterns, gotchas

        try:
            return await asyncio.to_thread(_both)
        except Exception as exc:  # noqa: BLE001 - memory never fails a build
            logger.warning("brain: memory read failed: %s", exc)
            return [], []

    def get_status_summary(self) -> dict:
        return self.status()

    async def _run(self, fn, *args) -> bool:
        try:
            return bool(await asyncio.to_thread(fn, *args))
        except Exception as exc:  # noqa: BLE001 - memory never fails a build
            logger.warning("brain: memory write failed: %s", exc)
            return False

    async def _read(self, fn, *args, **kwargs):
        try:
            return await asyncio.to_thread(fn, *args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - memory never fails a build
            logger.warning("brain: memory read failed: %s", exc)
            return []


def _body_text(hit: dict[str, Any]) -> str:
    """The note's own text: its first paragraph, without the title line."""
    content = hit["content"].split("\n", 1)
    body = content[1] if len(content) > 1 else content[0]
    return body.strip().split("\n\n", 1)[0].strip()


def open_project_memory(
    spec_dir: Path | str | None = None, project_dir: Path | str | None = None
) -> ProjectMemory | None:
    """The memory of *spec_dir*'s project as a build's agents recall it
    (`agent_memory`), or ``None`` when memory is off."""
    memory = ProjectMemory(spec_dir, project_dir)
    return agent_memory(memory, project_dir or spec_dir) if memory.is_enabled else None


def agent_memory(memory: ProjectMemory, workdir: Path | str | None) -> ProjectMemory:
    """*memory*, recalling for the build working in *workdir* (its worktree):
    its branch, and on a server the groups of the run's starter."""
    memory.audience = scopes.audience(workdir)
    return memory


# ---------------------------------------------------------------------------
# Hints for the features that ask "what do we know about this?"
# ---------------------------------------------------------------------------


async def get_graph_hints(
    query: str,
    project_id: str | Path | None = None,
    max_results: int = 10,
    spec_dir: Path | None = None,
) -> list[dict]:
    """What the vault knows about *query* for a project: its memory first, then
    the rest of the vault through graph-first recall.

    The signature of the Graphiti helper it replaces (spec pipeline, ideation,
    roadmap, context builder), and the same shape: ``content``, ``score``,
    ``type``. Never raises.
    """
    try:
        return await asyncio.to_thread(
            _graph_hints, query, project_id, max_results, spec_dir
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("brain: hints failed: %s", exc)
        return []


def _graph_hints(
    query: str, project_id: str | Path | None, max_results: int, spec_dir: Path | None
) -> list[dict]:
    if not is_memory_enabled() or not Brain().exists:
        return []
    project_dir = Path(project_id) if project_id else None
    memory = agent_memory(ProjectMemory(spec_dir, project_dir), project_dir or spec_dir)
    hints = (
        [
            {
                "content": h["content"],
                "score": h["score"],
                "type": h["type"],
                "path": h["path"],
            }
            for h in memory.search(query, limit=max_results)
        ]
        if memory.project
        else []
    )
    if len(hints) >= max_results:
        return hints
    brain = memory._brain or Brain()
    seen = {h["path"] for h in hints}
    try:
        recalled = brain.recall(query, limit=max_results, audience=memory.audience)[
            "hits"
        ]
    except Exception:  # noqa: BLE001 - a recall that fails leaves the memory hits
        recalled = []
    for hit in recalled:
        path = hit.get("source_file")
        if not path or path in seen or not str(path).endswith(".md"):
            continue
        front = hit.get("frontmatter") or {}
        hints.append(
            {
                "content": str(front.get("description") or hit.get("label") or path),
                "score": 0.5,
                "type": str(front.get("kind") or hit.get("kind") or "knowledge"),
                "path": path,
            }
        )
        if len(hints) >= max_results:
            break
    return hints


# ---------------------------------------------------------------------------
# The Memories tab and the HTTP API
# ---------------------------------------------------------------------------


def list_memories(
    project: str, *, limit: int = 20, brain: Brain | None = None
) -> list[dict[str, Any]]:
    """The project's most recent memories, newest first, in the tab's shape.

    From ``brain`` when given (a server project's own, read by
    ``shared_features.context``), else the person's brain.
    """
    memory = _for_person(project, brain)
    return (
        [_episode(h) for h in memory.search("", limit=limit)] if memory.project else []
    )


def _for_person(project: str, brain: Brain | None) -> ProjectMemory:
    """The memory a person reads: every note, the unverified ones marked —
    except in a server project's brain (``brain`` given), never synced."""
    return ProjectMemory(
        project=project, brain=brain, show_unverified=True, signatures=brain is None
    )


def search_memories(
    project: str, query: str, *, limit: int = 20, brain: Brain | None = None
) -> list[dict[str, Any]]:
    memory = _for_person(project, brain)
    if not memory.project:
        return []
    return [
        {
            "content": h["content"],
            "score": h["score"],
            "type": h["type"],
            "path": h["path"],
            "verified": h["verified"],
        }
        for h in memory.search(query, limit=limit)
    ]


_EPISODE_TYPES = {
    "gotcha": "gotcha",
    "pattern": "pattern",
    "codebase": "codebase_discovery",
    "outcome": "task_outcome",
    "session": "session_insight",
}


def _episode(hit: dict[str, Any]) -> dict[str, Any]:
    meta = hit["meta"]
    return {
        "id": hit["path"],
        "type": _EPISODE_TYPES.get(hit["type"], hit["type"]),
        "timestamp": str(meta.get("updated") or meta.get("created") or ""),
        "content": hit["content"],
        "session_number": meta.get("session_number"),
        "path": hit["path"],
        "pinned": meta.get("pinned") is True,
        "applies_to": str(meta.get("applies_to") or ""),
        "verified": hit.get("verified", True),
    }


# ---------------------------------------------------------------------------
# The files the old store left behind
# ---------------------------------------------------------------------------


def import_legacy_spec_memory(
    spec_dir: Path | str,
    project_dir: Path | str | None = None,
    *,
    brain: Brain | None = None,
) -> dict[str, Any]:
    """Move the knowledge in ``<spec_dir>/memory/`` into the vault, then set it aside.

    Read once, on the first use of that spec's memory (or by
    ``brain_runner.py --action import-legacy``): an upgrade must not lose what
    earlier builds learned, and must not leave it where a reader could take it
    for the current store. Only ``LEGACY_FILES`` are moved — to
    ``LEGACY_MIGRATED``, not deleted, so a person can check the import; the
    recovery state beside them is left where ``services/recovery.py`` reads it.
    """
    spec = Path(spec_dir)
    legacy = spec / "memory"
    report: dict[str, Any] = {"spec": spec.name, "imported": 0, "skipped": None}
    if not has_legacy_memory(spec):
        report["skipped"] = "no-legacy-memory"
        return report
    memory = ProjectMemory(spec, project_dir, brain=brain)
    memory._imported = True  # this *is* the import
    if memory._get_brain(create=True) is None:
        report["skipped"] = "memory-disabled"
        return report

    count = 0
    try:
        data = json.loads((legacy / "codebase_map.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    files = data.get("discovered_files")
    for path, value in (files if isinstance(files, dict) else data).items():
        if path.startswith("_") or path in ("last_updated",):
            continue
        desc = value.get("description") if isinstance(value, dict) else value
        category = value.get("category", "") if isinstance(value, dict) else ""
        count += memory.record_discovery(str(path), str(desc or ""), category=category)

    for name, record in (
        ("patterns.md", memory.record_pattern),
        ("gotchas.md", memory.record_gotcha),
    ):
        try:
            text = (legacy / name).read_text(encoding="utf-8")
        except OSError:
            continue
        for item in _markdown_items(text):
            count += record(item)

    sessions = legacy / "session_insights"
    for file in sorted(sessions.glob("session_*.json")) if sessions.is_dir() else []:
        try:
            insight = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(insight, dict):
            continue
        number = insight.get("session_number") or int(re.sub(r"\D", "", file.stem) or 0)
        count += memory.record_session(int(number), insight)

    memory.flush()
    _set_aside(spec, [legacy / name for name in LEGACY_FILES])
    report["imported"] = count
    return report


def has_legacy_memory(spec_dir: Path | str) -> bool:
    """Whether *spec_dir* still holds knowledge the old store wrote."""
    legacy = Path(spec_dir) / "memory"
    return any((legacy / name).exists() for name in LEGACY_FILES)


def _set_aside(spec: Path, paths: list[Path]) -> None:
    """Move the imported files under ``LEGACY_MIGRATED``; never over a first import."""
    present = [p for p in paths if p.exists()]
    if not present:
        return
    target = spec / LEGACY_MIGRATED
    if target.exists():
        target = spec / f"{LEGACY_MIGRATED}-{datetime.now():%Y%m%d%H%M%S}"
    try:
        target.mkdir(parents=True)
        for path in present:
            path.rename(target / path.name)
    except OSError as exc:
        logger.warning("brain: could not set aside the legacy memory: %s", exc)


def _markdown_items(text: str) -> list[str]:
    """Bullets (``- x``) and ``## [date]`` blocks — the two shapes the old files had."""
    items: list[str] = []
    block: list[str] | None = None

    def close() -> None:
        if block and "\n".join(block).strip():
            item = "\n".join(block).strip()
            items.append(re.sub(r"\n+_Context: (.*)_$", r" (Contexte : \1)", item))

    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## ["):
            close()
            block = []
        elif block is not None:
            block.append(line)
        elif stripped.startswith("- ") and stripped[2:].strip():
            items.append(stripped[2:].strip())
    close()
    return items
