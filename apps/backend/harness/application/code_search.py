"""`search_code`: ranked code excerpts from one project, for every provider.

The model asks; nothing is injected beforehand "in case" (D4 of the plan). One
call returns 5 to 8 excerpts, each with its path, symbol and line range so that
a file read can take exactly that range, and the offset of the next page. The
ranking is `harness.domain.code_ranking` over the chunks of
`harness.domain.code_chunks`; this module owns what touches the disk.

**The index.** Built on the first search of a project, kept in memory and
bounded: at most `MAX_INDEXES` projects (the least recently searched goes),
`MAX_FILES` files and `MAX_INDEX_BYTES` of source each. Before every search it
lists the files again and re-reads only those whose modification time or size
changed: an edit made a turn earlier is found, an unchanged file costs one
``lstat``. Nothing is written to disk.

**S4.** The files are git's (``git ls-files --cached --others
--exclude-standard``): tracked or new, never ignored, never under ``.git``.
Without git, a walk that follows no link and skips dependencies and hidden
directories. Every path is then resolved, links included, and kept only inside
the project root; a link is never followed, a binary or a file over
`MAX_FILE_BYTES` is skipped.

**S1.** An excerpt is masked by the secret table of the pre-commit scan
(`docintel.redact`) before it is returned. Without that table no code is
returned at all: the results keep their locations, and say why.

**S2.** The query is data: it is split into words by a fixed pattern, never
compiled as an expression, never used as a path or a command.

**S7.** No network: git runs locally, and there is no vector model.
"""

from __future__ import annotations

import logging
import os
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from stat import S_ISREG

from foundation.paging import page_items
from harness.domain.code_chunks import SYMBOL_KINDS, Chunk, chunk_file
from harness.domain.code_ranking import (
    Bm25Index,
    code_tokens,
    exact_ranking,
    excerpt_rows,
    identifier_key,
    query_identifiers,
    ranked,
    rrf,
    term_counts,
)

logger = logging.getLogger(__name__)

#: Results a call returns when the model asks for no number, and the most it
#: may ask for. Both are read at each call, and bounded by `RESULTS_CEILING`.
RESULTS_ENV = "CODE_SEARCH_RESULTS"
MAX_RESULTS_ENV = "CODE_SEARCH_MAX_RESULTS"
DEFAULT_RESULTS = 6
MAX_RESULTS = 8
RESULTS_CEILING = 20

#: How deep each ranking goes before the fusion: the last result a cursor reaches.
CANDIDATES = 200
#: The most one excerpt shows: lines, characters, and characters of one line.
EXCERPT_MAX_LINES = 30
EXCERPT_MAX_CHARS = 1_500
EXCERPT_LINE_CHARS = 200
#: A query longer than this is cut: it is a question, not a document.
QUERY_MAX_CHARS = 500

#: The bounds of one index. In memory it weighs about twice the source it
#: holds; a build or an MCP server works on one project, so two are kept.
MAX_FILE_BYTES = 1_000_000
MAX_FILES = 20_000
MAX_INDEX_BYTES = 48_000_000
MAX_INDEXES = 2
_GIT_TIMEOUT = 30
#: A walk without git lists this many files at most.
_WALK_MAX_FILES = 100_000

#: What is indexed: source, and the text a project explains itself with.
INDEXED_SUFFIXES = frozenset(
    {
        # split by symbol (`code_chunks.LANGUAGES`)
        ".py",
        ".pyi",
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".cs",
        ".java",
        ".go",
        ".rs",
        # windows
        ".kt",
        ".kts",
        ".swift",
        ".scala",
        ".rb",
        ".php",
        ".c",
        ".h",
        ".cc",
        ".cpp",
        ".hpp",
        ".m",
        ".vue",
        ".svelte",
        ".sql",
        ".sh",
        ".ps1",
        ".gradle",
        ".md",
        ".rst",
        ".yaml",
        ".yml",
        ".toml",
        ".json",
        ".xml",
        ".csproj",
        ".html",
        ".css",
        ".scss",
    }
)
#: Directories never indexed, even when tracked: dependencies, builds, caches,
#: and WorkPilot's own (specs, spilled tool output, task worktrees).
SKIP_DIRS = frozenset(
    {
        ".git",
        ".workpilot",
        ".worktrees",
        "node_modules",
        "__pycache__",
        ".venv",
        "venv",
        ".tox",
        ".mypy_cache",
        ".pytest_cache",
        ".ruff_cache",
        "dist",
        "build",
        "target",
        "bin",
        "obj",
        ".next",
        ".nuxt",
        "coverage",
    }
)
#: Generated files whose words would drown the code's.
SKIP_NAMES = frozenset(
    {
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "poetry.lock",
        "uv.lock",
        "Cargo.lock",
        "composer.lock",
        "Gemfile.lock",
        "go.sum",
    }
)


def _env_count(name: str, default: int, low: int, high: int) -> int:
    raw = os.environ.get(name, "").strip()
    try:
        value = int(raw) if raw else default
    except ValueError:
        logger.warning("Invalid %s=%r: using %d", name, raw, default)
        value = default
    return max(low, min(high, value))


def results_limits() -> tuple[int, int]:
    """(results by default, most results a call may ask for)."""
    most = _env_count(MAX_RESULTS_ENV, MAX_RESULTS, 1, RESULTS_CEILING)
    return _env_count(RESULTS_ENV, DEFAULT_RESULTS, 1, most), most


# --- Which files, and how they are read (S4) ---------------------------------


def _indexable(relative: str) -> bool:
    parts = relative.split("/")
    if any(part in SKIP_DIRS for part in parts[:-1]):
        return False
    name = parts[-1]
    if name in SKIP_NAMES or ".min." in name or name.endswith(".map"):
        return False
    dot = name.rfind(".")
    return dot > 0 and name[dot:].lower() in INDEXED_SUFFIXES


def _git_files(root: Path) -> list[str] | None:
    """Tracked and new files, ignored ones left out; None when git does not answer."""
    try:
        from foundation.git_executable import run_git

        result = run_git(
            ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
            cwd=root,
            timeout=_GIT_TIMEOUT,
        )
    except Exception as error:  # noqa: BLE001 - no git: the walk answers
        logger.debug("code search: git ls-files unavailable (%s)", error)
        return None
    if result.returncode != 0 or not result.stdout:
        return None
    return sorted({path for path in result.stdout.split("\0") if path})


def _walked_files(root: Path) -> list[str]:
    """Every file under ``root``, links not followed, hidden and dependency directories skipped."""
    found: list[str] = []
    for current, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = sorted(
            d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")
        )
        base = Path(current).relative_to(root).as_posix()
        for name in sorted(filenames):
            found.append(name if base == "." else f"{base}/{name}")
            if len(found) >= _WALK_MAX_FILES:
                return found
    return found


def list_files(root: Path) -> list[str]:
    """The project's indexable files, posix and relative to ``root``, in a stable order."""
    listed = _git_files(root)
    if listed is None:
        listed = _walked_files(root)
    return [relative for relative in listed if _indexable(relative)]


def resolve_within(root: Path, relative: str) -> Path | None:
    """The file ``relative`` names, resolved, or None when it is not a regular file inside ``root``.

    ``root`` is resolved already. A link is refused even when it points
    inside: what it points to is indexed under its own path.
    """
    pure = PurePosixPath(relative)
    if not relative or pure.is_absolute() or ".." in pure.parts:
        return None
    candidate = root.joinpath(*pure.parts)
    try:
        if candidate.is_symlink():
            return None
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        return None
    return resolved if resolved.is_file() else None


def _read_text(path: Path) -> str | None:
    """A text file's content, or None for a binary or an oversized one."""
    try:
        raw = path.read_bytes()
    except OSError:
        return None
    if len(raw) > MAX_FILE_BYTES or b"\0" in raw[:8192]:
        return None
    return raw.decode("utf-8", errors="replace")


# --- The index ----------------------------------------------------------------


@dataclass
class _FileEntry:
    signature: tuple[int, int]  # (mtime_ns, size)
    docs: list[int] = field(default_factory=list)


class CodeIndex:
    """One project's chunks, ranked by `search`; refreshed by file signature."""

    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.capped = False  # `MAX_FILES` or `MAX_INDEX_BYTES` was reached
        self._lock = threading.Lock()
        self._bm25 = Bm25Index()
        self._files: dict[str, _FileEntry] = {}
        self._chunks: dict[int, Chunk] = {}
        # identifier_key of a symbol's own name -> the chunks that define it
        self._defined: dict[str, list[int]] = {}

    @property
    def files(self) -> int:
        return len(self._files)

    def refresh(self) -> None:
        """Re-read what changed since the last search, drop what is gone."""
        with self._lock:
            self._refresh()

    def _refresh(self) -> None:
        seen: set[str] = set()
        used = 0
        capped = False
        root = str(self.root)
        for relative in list_files(self.root):
            if len(seen) >= MAX_FILES:
                capped = True
                break
            # One `lstat` tells an unchanged file from one to read again. A
            # link, a directory (a submodule) or a device is never read.
            try:
                stat = os.lstat(os.path.join(root, relative))
            except (OSError, ValueError):
                continue
            if not S_ISREG(stat.st_mode) or stat.st_size > MAX_FILE_BYTES:
                continue
            if used + stat.st_size > MAX_INDEX_BYTES:
                capped = True
                break
            signature = (stat.st_mtime_ns, stat.st_size)
            entry = self._files.get(relative)
            if entry is None or entry.signature != signature:
                if entry is not None:
                    self._drop(relative)
                # Nothing is read before its path is resolved inside the root.
                path = resolve_within(self.root, relative)
                if path is None:
                    continue
                self._add(relative, path, signature)
            used += stat.st_size
            seen.add(relative)
        for relative in [r for r in self._files if r not in seen]:
            self._drop(relative)
        self.capped = capped
        if self._bm25.dead > max(1_000, self._bm25.live):
            self._compact()

    def _add(self, relative: str, path: Path, signature: tuple[int, int]) -> None:
        entry = _FileEntry(signature)
        self._files[relative] = entry
        text = _read_text(path)
        if text is None:
            return  # kept with no chunk, so it is not read again until it changes
        lines = text.splitlines()
        for chunk in chunk_file(relative, text):
            body = "\n".join(lines[chunk.start - 1 : chunk.end])
            doc = self._bm25.add(term_counts(f"{chunk.context}\n{body}"))
            entry.docs.append(doc)
            self._chunks[doc] = chunk
            if chunk.kind in SYMBOL_KINDS:
                key = identifier_key(chunk.symbol.rsplit(".", 1)[-1])
                self._defined.setdefault(key, []).append(doc)

    def _drop(self, relative: str) -> None:
        entry = self._files.pop(relative)
        for doc in entry.docs:
            self._bm25.remove(doc)
            chunk = self._chunks.pop(doc)
            if chunk.kind in SYMBOL_KINDS:
                key = identifier_key(chunk.symbol.rsplit(".", 1)[-1])
                holders = self._defined.get(key, [])
                if doc in holders:
                    holders.remove(doc)
                if not holders:
                    self._defined.pop(key, None)

    def _compact(self) -> None:
        mapping = self._bm25.compact()
        self._chunks = {mapping[doc]: chunk for doc, chunk in self._chunks.items()}
        for entry in self._files.values():
            entry.docs = [mapping[doc] for doc in entry.docs]
        self._defined = {
            key: [mapping[doc] for doc in docs] for key, docs in self._defined.items()
        }

    def _defining(self, key: str) -> set[int]:
        return set(self._defined.get(key, ()))

    def rank(self, query: str) -> list[Chunk]:
        """The chunks for ``query``, best first, at most about 2 × `CANDIDATES`."""
        with self._lock:
            self._refresh()
            terms = code_tokens(query)
            lexical = ranked(self._bm25.scores(terms), CANDIDATES)
            exact = exact_ranking(
                query_identifiers(query), self._bm25.containing, self._defining
            )[:CANDIDATES]
            return [self._chunks[doc] for doc in rrf([lexical, exact])]


_INDEXES: OrderedDict[str, CodeIndex] = OrderedDict()
_INDEXES_LOCK = threading.Lock()


def index_for(project_dir: str | Path) -> CodeIndex:
    """The cached index of a project; the least recently used goes past `MAX_INDEXES`."""
    root = Path(project_dir).resolve()
    key = str(root)
    with _INDEXES_LOCK:
        index = _INDEXES.get(key)
        if index is None:
            index = _INDEXES[key] = CodeIndex(root)
        _INDEXES.move_to_end(key)
        while len(_INDEXES) > MAX_INDEXES:
            _INDEXES.popitem(last=False)
    return index


def clear_indexes() -> None:
    """Forget every cached index (tests, and a process that wants its memory back)."""
    with _INDEXES_LOCK:
        _INDEXES.clear()


# --- One call -------------------------------------------------------------------


#: Room kept under the page cap for the header and the cursor line.
_HEADER_RESERVE = 240
_FOOTER_RESERVE = 140
_WITHHELD = (
    "[code withheld: the secret scan that masks excerpts is unavailable, "
    "so only locations are shown]"
)


def _secret_mask() -> Callable[[str], str] | None:
    """The pre-commit scan's masking, or None when its table cannot be loaded."""
    try:
        from docintel.redact import redact_text

        redact_text("probe")  # loads the table, or raises
    except Exception:  # noqa: BLE001 - fail closed: the caller returns no code
        return None
    return lambda text: redact_text(text)[0]


def _excerpt(
    index: CodeIndex,
    chunk: Chunk,
    terms: set[str],
    max_chars: int,
    files: dict[str, list[str] | None],
) -> str:
    """The lines of ``chunk`` worth showing, numbered, within ``max_chars``."""
    if chunk.path not in files:
        path = resolve_within(index.root, chunk.path)
        text = _read_text(path) if path is not None else None
        files[chunk.path] = text.splitlines() if text is not None else None
    lines = files[chunk.path]
    if lines is None:
        return "(the file can no longer be read)"
    body = lines[chunk.start - 1 : chunk.end]
    shown: list[str] = []
    used = 0
    for row in excerpt_rows(body, terms, EXCERPT_MAX_LINES):
        if row is None:
            line = "…"
        else:
            text = body[row]
            if len(text) > EXCERPT_LINE_CHARS:
                text = text[:EXCERPT_LINE_CHARS] + "…"
            line = f"{chunk.start + row}: {text}"
        if shown and used + len(line) + 1 > max_chars:
            shown.append("…")
            break
        shown.append(line)
        used += len(line) + 1
    return "\n".join(shown)


def _blocks(
    index: CodeIndex,
    hits: Iterable[tuple[int, Chunk]],
    terms: set[str],
    per_result: int,
    mask: Callable[[str], str] | None,
    withheld: list[bool],
) -> Iterable[str]:
    """Each result as the model reads it, masked, or its location alone."""
    files: dict[str, list[str] | None] = {}
    for number, chunk in hits:
        head = f"{number}. {chunk.location}"
        if mask is not None:
            block = f"{head}\n{_excerpt(index, chunk, terms, per_result, files)}"
            try:
                yield mask(block)
                continue
            except Exception:  # noqa: BLE001 - fail closed: no unmasked code
                mask = None
        withheld[0] = True
        yield head


def search_code(
    project_dir: str | Path,
    query: str,
    *,
    offset: int = 0,
    limit: int | None = None,
    max_chars: int,
) -> str:
    """Ranked excerpts for ``query``, a page of them, as the model reads them."""
    query = str(query or "").strip()[:QUERY_MAX_CHARS]
    if not query:
        raise ValueError("query is required for search_code")
    if not code_tokens(query):
        return (
            "(no word to search for in that query: name an identifier, a file, "
            "or what the code does)"
        )
    default, most = results_limits()
    limit = max(1, min(most, limit or default))
    offset = max(0, offset)

    index = index_for(project_dir)
    hits = index.rank(query)
    capped = (
        f"[the index holds the first {index.files} files of the project only: "
        "search the rest with a text search]"
        if index.capped
        else ""
    )
    if offset >= len(hits):
        empty = "(no matches)" if not hits else "(no more results)"
        return f"{empty}\n\n{capped}" if capped else empty

    mask = _secret_mask()
    withheld = [mask is None]
    notes = [note for note in (_WITHHELD if mask is None else "", capped) if note]
    # Results are joined by a blank line: two characters each, where
    # `page_items` counts one.
    reserve = _HEADER_RESERVE + _FOOTER_RESERVE + limit
    reserve += sum(len(note) + 2 for note in notes)
    budget = max(300, max_chars - reserve)
    per_result = max(200, min(EXCERPT_MAX_CHARS, budget // limit - 100))
    page, rest = page_items(
        _blocks(
            index,
            enumerate(hits[offset:], start=offset + 1),
            set(code_tokens(query)),
            per_result,
            mask,
            withheld,
        ),
        max_items=limit,
        max_chars=budget,
    )
    if withheld[0] and _WITHHELD not in notes:
        notes.insert(0, _WITHHELD)  # the scan failed on an excerpt, not before
    shown_to = offset + len(page)
    header = (
        f"[search_code: results {offset + 1}–{shown_to} of {len(hits)}. "
        "Each gives path:first-last line and its symbol: read more of one with "
        "the file-reading tool, starting at its first line]"
    )
    lines = [header, *notes, *page]
    if rest is not None:
        lines.append(
            f"(more results: call search_code again with offset={offset + rest}, "
            "or ask a narrower question)"
        )
    return "\n\n".join(lines)
