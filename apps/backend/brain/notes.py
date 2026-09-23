"""A note: one Markdown file with frontmatter, the unit the brain is made of.

Obsidian's conventions, kept exactly, because the brain is meant to be opened
in Obsidian: YAML frontmatter, ``[[wikilinks]]`` (with ``|alias`` and
``#heading`` suffixes), ``#tags`` in the body as well as ``tags:`` in the
frontmatter. The frontmatter is read through the one parser this repository
has (`skills_registry.frontmatter`), never a fifth one.

Writing is atomic (temporary file, then rename). Several agents write the same
brain, sometimes at the same moment, and a half-written note is a note the next
graph build parses as garbage.
"""

from __future__ import annotations

import os
import re
import tempfile
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from skills_registry.frontmatter import parse_frontmatter

__all__ = [
    "Note",
    "read_note",
    "write_note",
    "iter_notes",
    "slugify",
    "wikilinks",
    "body_tags",
    "now_iso",
    "inside",
]

_WIKILINK = re.compile(r"\[\[([^\]\|#]+)(?:#[^\]\|]*)?(?:\|[^\]]*)?\]\]")
_TAG = re.compile(r"(?<![\w/#&])#([A-Za-z][\w/-]*)")
_FENCE = re.compile(r"```.*?```", re.DOTALL)

# Never part of the brain's content: Obsidian's own state, git, and the
# generated graph.
_SKIP_DIRS = {".git", ".obsidian", ".trash", "graphify-out", ".brain"}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def slugify(text: str, max_len: int = 64) -> str:
    """A filename a person can read and every filesystem accepts."""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", folded).strip("-").lower()
    return (slug[:max_len].rstrip("-")) or "note"


def wikilinks(body: str) -> list[str]:
    """Link targets, in order, without duplicates. Code blocks are not prose."""
    seen: dict[str, None] = {}
    for match in _WIKILINK.finditer(_FENCE.sub("", body)):
        seen.setdefault(match.group(1).strip(), None)
    return list(seen)


def body_tags(body: str) -> list[str]:
    seen: dict[str, None] = {}
    for match in _TAG.finditer(_FENCE.sub("", body)):
        seen.setdefault(match.group(1).lower(), None)
    return list(seen)


@dataclass
class Note:
    path: Path
    """Relative to the brain root, with forward slashes when rendered."""
    meta: dict[str, Any] = field(default_factory=dict)
    body: str = ""

    @property
    def rel(self) -> str:
        return self.path.as_posix()

    @property
    def stem(self) -> str:
        return self.path.stem

    @property
    def title(self) -> str:
        title = self.meta.get("title")
        if isinstance(title, str) and title.strip():
            return title.strip()
        name = self.meta.get("name")
        if isinstance(name, str) and name.strip():
            return name.strip()
        for line in self.body.splitlines():
            if line.startswith("# "):
                return line[2:].strip()
        return self.stem if self.stem != "SKILL" else self.path.parent.name

    @property
    def kind(self) -> str:
        kind = self.meta.get("kind")
        if isinstance(kind, str) and kind:
            return kind
        head = self.path.parts[0] if len(self.path.parts) > 1 else ""
        return {
            "instructions": "instruction",
            "knowledge": "knowledge",
            "agents": "agent-memory",
            "skills": "skill",
        }.get(head, "note")

    @property
    def tags(self) -> list[str]:
        raw = self.meta.get("tags") or []
        if isinstance(raw, str):
            raw = [part.strip() for part in raw.split(",")]
        if not isinstance(raw, (list, tuple, set)):
            raw = [raw]
        # ``tags: [null]`` is an empty Obsidian property, not a tag named "None".
        tags = {
            str(t).strip().lstrip("#").lower(): None
            for t in raw
            if t is not None and str(t).strip().lstrip("#")
        }
        for tag in body_tags(self.body):
            tags.setdefault(tag, None)
        return list(tags)

    @property
    def links(self) -> list[str]:
        return wikilinks(self.body)

    def render(self) -> str:
        import yaml

        head = yaml.safe_dump(self.meta, allow_unicode=True, sort_keys=False).strip()
        body = self.body if self.body.endswith("\n") else self.body + "\n"
        return f"---\n{head}\n---\n\n{body.lstrip(chr(10))}"


def inside(root: Path | str, rel: Path | str) -> Path:
    """*rel* resolved under *root*, or ``ValueError`` if it would leave it.

    The one gate every note path goes through before a file is opened. Note
    paths arrive from MCP tool calls, the HTTP API and agents that have read
    untrusted content, so ``../`` and absolute paths are not hypothetical.
    Written as normalise-then-prefix-check, the shape path-injection analysis
    (CodeQL ``py/path-injection``) recognises as a sanitiser.
    """
    base = os.path.normpath(os.path.abspath(os.fspath(root)))
    full = os.path.normpath(os.path.join(base, os.fspath(rel)))
    if not full.startswith(base + os.sep):
        raise ValueError(f"refusing a path outside the brain: {rel}")
    return Path(full)


def read_note(root: Path, rel: Path | str) -> Note:
    target = inside(root, rel)
    text = target.read_text(encoding="utf-8", errors="replace")
    meta, body = parse_frontmatter(text)
    return Note(path=Path(rel), meta=dict(meta or {}), body=body)


def write_note(root: Path, note: Note) -> Path:
    """Write *note* under *root* atomically; returns the absolute path."""
    target = inside(root, note.path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".note-", suffix=".md", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(note.render())
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return target


def iter_notes(root: Path):
    """Every Markdown note of the vault, relative paths, in a stable order."""
    if not root.is_dir():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")
        )
        for name in sorted(filenames):
            if name.endswith(".md") and not name.startswith("."):
                yield (Path(dirpath) / name).relative_to(root)
