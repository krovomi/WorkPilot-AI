"""The preflight itself: detect, download, hand the result to the agents.

Runs once per build, before planning, and answers one question — *is there a
library here the agent will have to write blind?* When there is, the current
documentation is on disk before the first prompt is assembled, inside the spec
directory the agent already reads, named in the prompt with a relative path.

Why not leave it to the MCP tools. Context7 is declared for the coder and it
stays declared: mid-session, when the agent notices it is unsure, calling
`query-docs` is exactly right. The failure this fixes is the other one — the
agent does not notice. It recognises `stripe`, writes the call it remembers,
and the reviewer only catches it if the wrong API happens to fail loudly. A
tool that fires when the model feels uncertain cannot cover the case where the
model is confidently wrong; reading the manifests can.

Nothing here is allowed to break a build. No network, no API key, quota spent,
library not indexed: the result records why, the pipeline prints one line, and
the session proceeds with the MCP tools it always had.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .cache import DocsCache
from .context7 import (
    Context7Client,
    Context7Error,
    Context7RateLimited,
    Library,
    api_key_from_env,
    pick_version,
)
from .detect import DEFAULT_LIMIT, LibraryNeed, detect_needs

logger = logging.getLogger(__name__)

__all__ = [
    "DOCS_DIRNAME",
    "RESULT_FILENAME",
    "DocEntry",
    "PreflightResult",
    "format_docs_for_prompt",
    "is_enabled",
    "load_result",
    "project_env",
    "read_task_text",
    "run_preflight",
]

DOCS_DIRNAME = "docs"
RESULT_FILENAME = "docs_context.json"

_WORKPILOT_DIR = ".workpilot"
_SETTINGS_KEYS = (
    "CONTEXT7_ENABLED",
    "CONTEXT7_API_KEY",
    "CONTEXT7_API_URL",
    "LIBDOCS_ENABLED",
    "LIBDOCS_MAX_LIBRARIES",
    "LIBDOCS_TTL_DAYS",
)
_ENABLED_ENV = "LIBDOCS_ENABLED"
_CONTEXT7_ENABLED_ENV = "CONTEXT7_ENABLED"
_LIMIT_ENV = "LIBDOCS_MAX_LIBRARIES"
_QUERY_CHARS = 180


@dataclass(frozen=True)
class DocEntry:
    """One downloaded page, as the prompt will refer to it."""

    library: str
    library_id: str
    query: str
    path: str
    """Relative to the agent's working directory, because the agent is told its
    filesystem starts there."""
    reason: str = ""
    from_cache: bool = False
    size: int = 0


@dataclass
class PreflightResult:
    """What the preflight found, downloaded and could not download."""

    entries: list[DocEntry] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    enabled: bool = True

    @property
    def downloaded(self) -> int:
        return sum(1 for entry in self.entries if not entry.from_cache)

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "entries": [asdict(entry) for entry in self.entries],
            "skipped": [list(pair) for pair in self.skipped],
            "errors": list(self.errors),
        }

    @classmethod
    def from_dict(cls, payload: dict) -> PreflightResult:
        entries = []
        for raw in payload.get("entries") or []:
            if not isinstance(raw, dict):
                continue
            entries.append(
                DocEntry(
                    library=str(raw.get("library", "")),
                    library_id=str(raw.get("library_id", "")),
                    query=str(raw.get("query", "")),
                    path=str(raw.get("path", "")),
                    reason=str(raw.get("reason", "")),
                    from_cache=bool(raw.get("from_cache", False)),
                    size=int(raw.get("size", 0) or 0),
                )
            )
        skipped = [
            (str(pair[0]), str(pair[1]))
            for pair in payload.get("skipped") or []
            if isinstance(pair, (list, tuple)) and len(pair) == 2
        ]
        return cls(
            entries=entries,
            skipped=skipped,
            errors=[str(e) for e in payload.get("errors") or []],
            enabled=bool(payload.get("enabled", True)),
        )

    def describe(self) -> str:
        """One block for the build banner. Silent when there is nothing to say."""
        if not self.enabled:
            return ""
        lines = []
        for entry in self.entries:
            mark = "cached" if entry.from_cache else "downloaded"
            lines.append(f"  ✓  {entry.library:<24} {entry.library_id} ({mark})")
        for name, why in self.skipped:
            lines.append(f"  –  {name:<24} {why}")
        for error in self.errors:
            lines.append(f"  ?  {error}")
        if not lines:
            return ""
        return "\n".join(["Library documentation:", *lines])


def is_enabled(env: dict | None = None) -> bool:
    """Whether the preflight runs.

    It follows `CONTEXT7_ENABLED` as well as its own switch: a user who turned
    the Context7 MCP server off in settings has said what they think about
    sending their task text to Context7, and this path sends the same thing.
    """
    source = os.environ if env is None else env
    if str(source.get(_CONTEXT7_ENABLED_ENV, "true")).strip().lower() == "false":
        return False
    return str(source.get(_ENABLED_ENV, "true")).strip().lower() != "false"


def project_env(project_dir: Path) -> dict[str, str]:
    """The Context7 settings a project carries in `.workpilot/.env`.

    That file is what the Electron settings screen writes, so the toggle and
    the API key a user set in the UI reach this path too and not only the MCP
    server. Real environment variables win over it: a CLI user who exported a
    key should not be overridden by a stale one on disk.
    """
    path = Path(project_dir) / _WORKPILOT_DIR / ".env"
    values: dict[str, str] = {}
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return values
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, raw = line.split("=", 1)
        key = key.strip()
        if key in _SETTINGS_KEYS:
            values[key] = raw.strip().strip("\"'")
    return values


def read_task_text(spec_dir: Path) -> str:
    """The task as written, from whichever spec artefacts exist yet."""
    parts: list[str] = []
    spec_md = Path(spec_dir) / "spec.md"
    if spec_md.exists():
        try:
            parts.append(spec_md.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            pass
    for name in ("requirements.json", "task_metadata.json"):
        path = Path(spec_dir) / name
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        parts.append(_flatten(payload))
    return "\n".join(part for part in parts if part)


def _flatten(payload: object, depth: int = 0) -> str:
    """Every string in a JSON document, so a library named in any field counts."""
    if depth > 6:
        return ""
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        return "\n".join(_flatten(value, depth + 1) for value in payload.values())
    if isinstance(payload, list):
        return "\n".join(_flatten(item, depth + 1) for item in payload)
    return ""


def _query_for(task_text: str, library: str) -> str:
    """The question the documentation is reranked against.

    Context7 answers a query, not a table of contents, so the task's own words
    are what make the page useful. Keying the cache on this means two specs
    about the same library download twice — accepted: a generic page shared
    between tasks is the outcome this package exists to avoid.
    """
    summary = " ".join((task_text or "").split())[:_QUERY_CHARS].strip()
    if not summary:
        return f"how to use {library}"
    return f"{library}: {summary}"


def _limit_from_env(explicit: int | None, env: dict | None = None) -> int:
    if explicit is not None:
        return explicit
    source = os.environ if env is None else env
    try:
        return int(source.get(_LIMIT_ENV, ""))
    except (TypeError, ValueError):
        return DEFAULT_LIMIT


def _ttl_from(env: dict) -> int | None:
    try:
        return int(env["LIBDOCS_TTL_DAYS"])
    except (KeyError, TypeError, ValueError):
        return None


def run_preflight(
    project_dir: Path,
    spec_dir: Path,
    *,
    cache_dir: Path | None = None,
    task_text: str | None = None,
    limit: int | None = None,
    client: Context7Client | None = None,
    needs: list[LibraryNeed] | None = None,
) -> PreflightResult:
    """Detect, download and stage the documentation this build needs.

    `cache_dir` is the *source* project when the build runs in a worktree: the
    cache outlives the branch, the staged copies do not.
    """
    project_dir = Path(project_dir)
    spec_dir = Path(spec_dir)
    settings_dir = Path(cache_dir) if cache_dir else project_dir
    env = {**project_env(settings_dir), **os.environ}
    # Every path below writes the result, including the ones that found or
    # fetched nothing. A run that leaves the previous file in place would have
    # the coder read a section listing what the *last* task needed.
    if not is_enabled(env):
        return _persist(spec_dir, PreflightResult(enabled=False))

    text = read_task_text(spec_dir) if task_text is None else task_text
    budget = _limit_from_env(limit, env)
    if budget <= 0:
        return _persist(spec_dir, PreflightResult())

    try:
        candidates = (
            detect_needs(project_dir, text, limit=budget) if needs is None else needs
        )
    except Exception as exc:  # noqa: BLE001 - detection never fails a build
        logger.debug("libdocs: detection failed: %s", exc)
        return _persist(spec_dir, PreflightResult(errors=[f"detection failed: {exc}"]))

    result = PreflightResult()
    if not candidates:
        return _persist(spec_dir, result)

    cache = DocsCache(settings_dir, ttl_days=_ttl_from(env))
    fetcher = client or Context7Client(
        api_key_from_env(env), base_url=env.get("CONTEXT7_API_URL") or None
    )
    if not api_key_from_env(env):
        logger.debug("libdocs: no CONTEXT7_API_KEY; anonymous quota applies")

    for need in candidates[:budget]:
        query = _query_for(text, need.name)
        try:
            entry = _acquire(fetcher, cache, need, query, spec_dir, project_dir)
        except Context7RateLimited as exc:
            # The quota does not come back mid-build, so the remaining
            # candidates would each spend a call to be told the same thing.
            result.errors.append(f"{need.name}: {exc}")
            break
        except Context7Error as exc:
            result.errors.append(f"{need.name}: {exc}")
            continue
        except Exception as exc:  # noqa: BLE001 - staging is best effort
            logger.debug("libdocs: %s failed: %s", need.name, exc)
            result.errors.append(f"{need.name}: {exc}")
            continue
        if entry is None:
            result.skipped.append((need.name, "not in the Context7 index"))
            continue
        result.entries.append(entry)

    return _persist(spec_dir, result)


def _acquire(
    client: Context7Client,
    cache: DocsCache,
    need: LibraryNeed,
    query: str,
    spec_dir: Path,
    project_dir: Path,
) -> DocEntry | None:
    library = client.resolve(need.name, query)
    if library is None:
        return None
    library_id = _pin(library, need.version)

    cached = cache.get(library_id, query)
    from_cache = cached is not None
    if cached is None:
        text = client.docs(library_id, query)
        cached = cache.put(library_id, need.name, query, text)

    staged = _stage(spec_dir, need, library, library_id, query, cached.read())
    return DocEntry(
        library=need.name,
        library_id=library_id,
        query=query,
        path=_relative(staged, project_dir),
        reason=", ".join(need.reasons),
        from_cache=from_cache,
        size=cached.size,
    )


def _pin(library: Library, declared_version: str) -> str:
    version = pick_version(library, declared_version)
    if not version:
        return library.id
    return f"{library.id.rstrip('/')}/{version.lstrip('/')}"


def _stage(
    spec_dir: Path,
    need: LibraryNeed,
    library: Library,
    library_id: str,
    query: str,
    body: str,
) -> Path:
    """Copy one cached page next to the spec, with its provenance on top.

    Inside the spec directory rather than referenced in the shared cache
    because the agent is told its filesystem starts at the working directory,
    and in a worktree the cache is not under it. The header is not decoration:
    a page with no date is a page whose staleness cannot be judged by whoever
    reads the diff later.
    """
    from .cache import slugify

    docs_dir = Path(spec_dir) / DOCS_DIRNAME
    docs_dir.mkdir(parents=True, exist_ok=True)
    path = docs_dir / f"{slugify(need.name)}.md"
    header = "\n".join(
        [
            f"# {need.name} — documentation",
            "",
            f"- Context7 library: `{library_id}`",
            f"- Title: {library.title or need.name}",
            f"- Query: {query}",
            f"- Why it was fetched: {', '.join(need.reasons) or 'unspecified'}",
            "",
            "Downloaded by WorkPilot before this build. For anything this page "
            "does not answer, call `mcp__context7__query-docs` with the library "
            "id above.",
            "",
            "---",
            "",
        ]
    )
    path.write_text(header + body, encoding="utf-8")
    return path


def _relative(path: Path, project_dir: Path) -> str:
    try:
        return Path(path).relative_to(project_dir).as_posix()
    except ValueError:
        return Path(path).as_posix()


def _persist(spec_dir: Path, result: PreflightResult) -> PreflightResult:
    """Record the result next to the spec and hand it back to the caller."""
    try:
        Path(spec_dir).mkdir(parents=True, exist_ok=True)
        (Path(spec_dir) / RESULT_FILENAME).write_text(
            json.dumps(result.to_dict(), indent=2), encoding="utf-8"
        )
    except OSError as exc:
        logger.debug("libdocs: could not persist the preflight result: %s", exc)
    return result


def load_result(spec_dir: Path) -> PreflightResult | None:
    """What the preflight staged for this spec, or None when it never ran."""
    path = Path(spec_dir) / RESULT_FILENAME
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    return PreflightResult.from_dict(payload)


def format_docs_for_prompt(
    result: PreflightResult | None, *, subtask: dict | None = None
) -> str:
    """The prompt section that makes the download worth having.

    Pointers, never the pages themselves: inlining thousands of tokens of
    reference material into every subtask prompt would be paid on every turn,
    for a library the subtask may not touch. The agent reads the file when the
    file is about its subtask, which is the same discipline the rest of the
    context injection follows.

    When a subtask is given, entries whose library it actually names come
    first; the others stay listed, because a plan that failed to mention the
    library is exactly the plan whose subtask is about to use it anyway.
    """
    if result is None or not result.enabled or not result.entries:
        return ""

    entries = list(result.entries)
    if subtask:
        haystack = " ".join(
            str(part).lower()
            for part in (
                subtask.get("description", ""),
                subtask.get("id", ""),
                " ".join(subtask.get("files_to_modify", []) or []),
                " ".join(subtask.get("files_to_create", []) or []),
            )
        )
        entries.sort(key=lambda e: e.library.lower() not in haystack)

    lines = [
        "## Library documentation already downloaded",
        "",
        "The codebase has no usable example for these libraries, so their "
        "current documentation was fetched before this session started. "
        "**Read the file before writing code against the library** — do not "
        "write the API from memory.",
        "",
    ]
    for entry in entries:
        lines.append(f"- **{entry.library}** (`{entry.library_id}`) → `{entry.path}`")
    lines.extend(
        [
            "",
            "If a page does not cover what you need, call "
            "`mcp__context7__query-docs` with the library id above and a "
            "precise question.",
        ]
    )
    return "\n".join(lines)
