"""Where downloaded documentation lives between builds.

Two properties are worth more than anything clever here.

**It is shared.** The cache is keyed on the library and the question, and it
sits in the source project's `.workpilot/`, not in the worktree — so the second
task that touches the same library that week pays nothing, and a worktree
thrown away after a merge does not take the download with it.

**It expires.** The whole premise is that upstream moved on since the model was
trained; a cache with no TTL reintroduces exactly that problem on a shorter
timescale. Fourteen days is the default because it is long enough for a week of
tasks on one library and short enough that a release lands within it.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

__all__ = [
    "CACHE_DIRNAME",
    "DEFAULT_TTL_DAYS",
    "MAX_DOC_BYTES",
    "CachedDoc",
    "DocsCache",
    "slugify",
]

CACHE_DIRNAME = "docs-cache"
DEFAULT_TTL_DAYS = 14
MAX_DOC_BYTES = 200_000
"""A ceiling on one stored page.

Context7 reranks and returns a bounded answer, so this is a guard rather than a
policy — but the file is read into a coder prompt, and an unbounded file there
is an unbounded bill.
"""

_TTL_ENV = "LIBDOCS_TTL_DAYS"
_WORKPILOT_DIR = ".workpilot"
_INDEX_NAME = "index.json"


def slugify(raw: str) -> str:
    """A filesystem-safe stand-in for a library id.

    Library ids are paths (`/vercel/next.js`), and versions add a second slash.
    Flattening them keeps the cache one directory deep on every platform —
    Windows included, where the nesting would otherwise start colliding with
    path length limits inside a worktree.
    """
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", str(raw).strip("/"))
    return cleaned.strip("-").lower() or "library"


@dataclass(frozen=True)
class CachedDoc:
    library_id: str
    library_name: str
    query: str
    path: Path
    fetched_at: str
    size: int = 0

    def to_dict(self) -> dict:
        return {
            "library_id": self.library_id,
            "library_name": self.library_name,
            "query": self.query,
            "file": self.path.name,
            "fetched_at": self.fetched_at,
            "size": self.size,
        }

    def read(self) -> str:
        try:
            return self.path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""


class DocsCache:
    """The documentation this project has already downloaded."""

    def __init__(self, project_dir: Path, *, ttl_days: int | None = None):
        self.project_dir = Path(project_dir)
        self.ttl_days = ttl_days if ttl_days is not None else _ttl_from_env()

    @property
    def root(self) -> Path:
        return self.project_dir / _WORKPILOT_DIR / CACHE_DIRNAME

    @property
    def index_path(self) -> Path:
        return self.root / _INDEX_NAME

    # -- reads -------------------------------------------------------------

    def get(self, library_id: str, query: str) -> CachedDoc | None:
        """The cached answer, or None when absent, stale or gone from disk."""
        key = _key(library_id, query)
        record = self._index().get(key)
        if not isinstance(record, dict):
            return None
        doc = self._materialise(record)
        if doc is None:
            return None
        if self._expired(doc.fetched_at):
            return None
        if not doc.path.exists():
            return None
        return doc

    def entries(self) -> list[CachedDoc]:
        docs = [self._materialise(record) for record in self._index().values()]
        return [doc for doc in docs if doc is not None and doc.path.exists()]

    # -- writes ------------------------------------------------------------

    def put(
        self, library_id: str, library_name: str, query: str, text: str
    ) -> CachedDoc:
        """Store one page and return its record."""
        key = _key(library_id, query)
        body = text if len(text) <= MAX_DOC_BYTES else _truncate(text)
        path = self.root / f"{slugify(library_id)}-{key[:8]}.md"
        self.root.mkdir(parents=True, exist_ok=True)
        _atomic_write(path, body)

        doc = CachedDoc(
            library_id=library_id,
            library_name=library_name,
            query=query,
            path=path,
            fetched_at=_now(),
            size=len(body),
        )
        index = self._index()
        index[key] = doc.to_dict()
        self._write_index(index)
        return doc

    def prune(self) -> int:
        """Drop expired entries and their files. Returns how many went."""
        index = self._index()
        dropped = 0
        for key, record in list(index.items()):
            doc = self._materialise(record)
            if doc is None or self._expired(doc.fetched_at):
                if doc is not None:
                    try:
                        doc.path.unlink(missing_ok=True)
                    except OSError:
                        # The index entry goes either way. A page left on disk
                        # that nothing points at costs a few kilobytes; a
                        # pruning pass that aborts on one locked file leaves
                        # every later entry expired and still served.
                        pass
                index.pop(key, None)
                dropped += 1
        if dropped:
            self._write_index(index)
        return dropped

    # -- internals ---------------------------------------------------------

    def _index(self) -> dict:
        try:
            payload = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        return payload if isinstance(payload, dict) else {}

    def _write_index(self, index: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        _atomic_write(self.index_path, json.dumps(index, indent=2, sort_keys=True))

    def _materialise(self, record: dict) -> CachedDoc | None:
        filename = record.get("file")
        if not filename:
            return None
        return CachedDoc(
            library_id=str(record.get("library_id", "")),
            library_name=str(record.get("library_name", "")),
            query=str(record.get("query", "")),
            path=self.root / str(filename),
            fetched_at=str(record.get("fetched_at", "")),
            size=int(record.get("size", 0) or 0),
        )

    def _expired(self, fetched_at: str) -> bool:
        if self.ttl_days <= 0:
            return False
        stamp = _parse(fetched_at)
        if stamp is None:
            # An unreadable timestamp is treated as expired: re-downloading
            # costs one call, serving documentation of unknown age costs a
            # coder writing against an API that may no longer exist.
            return True
        return stamp < datetime.now(timezone.utc) - timedelta(days=self.ttl_days)


def _ttl_from_env() -> int:
    raw = os.environ.get(_TTL_ENV, "")
    try:
        return int(raw)
    except (TypeError, ValueError):
        return DEFAULT_TTL_DAYS


def _key(library_id: str, query: str) -> str:
    """The cache key for one (library, question) pair.

    A filename, not a security primitive — but sha256 is what the rest of the
    backend keys its caches on, and picking anything weaker here only buys an
    argument with the security scanner.
    """
    digest = hashlib.sha256(f"{library_id}\n{query}".encode()).hexdigest()
    return digest[:16]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _parse(raw: str) -> datetime | None:
    try:
        stamp = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=timezone.utc)
    return stamp


def _truncate(text: str) -> str:
    head = text[:MAX_DOC_BYTES]
    cut = head.rfind("\n")
    if cut > MAX_DOC_BYTES // 2:
        head = head[:cut]
    return head + "\n\n<!-- truncated by WorkPilot: page exceeded the cache limit -->\n"


def _atomic_write(path: Path, text: str) -> None:
    """Write through a temporary file in the same directory.

    Two builds can run at once — the product's whole point is parallel agents —
    and a half-written page read by the other one would be indistinguishable
    from documentation that simply stops mid-sentence.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=str(path.parent),
        prefix=f".{path.name}.",
        suffix=".tmp",
        delete=False,
    )
    try:
        with handle as stream:
            stream.write(text)
        os.replace(handle.name, path)
    except OSError:
        try:
            os.unlink(handle.name)
        except OSError:
            # Cleanup of the temporary file is a courtesy; the write failure
            # below it is what the caller needs to hear about.
            pass
        raise
