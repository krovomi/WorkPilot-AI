"""The images of the vault, read once and found by their text.

A vault holds more than notes: the screenshot pasted into a daily note, the
architecture schema exported from draw.io, the photo of a whiteboard. Recall
used to see them as ghost links — ``[[schema.png]]`` resolved to nothing, and
"where is the diagram of the order flow" had no answer unless somebody had
typed its words into a note.

Each image becomes a node of ``graph.json`` whose metadata carries what could
be read out of it — the text, the engine that read it, the date — so
``brain_recall`` finds a capture by what it says.

The reading is docintel's, never a second one:

- **structured first** — a draw.io or Excalidraw export embeds its source, and
  `docintel.diagrams.parse_diagram` reads its boxes and arrows;
- **OCR last, and on the machine only** — `docintel.ocr.ocr_image`, with the
  chain filtered to the engines that run locally and no project to read a
  policy from, which is precisely the case where the chain refuses a cloud
  engine. The graph is rebuilt after every write of every agent: it is the last
  place a screenshot should leave the machine from, airgap or not;
- **the preview's engines only** — a vision model is too slow to run inside a
  rebuild. It is ``deferred``, like on the Kanban panel.

Then docintel's protection, in its order: invisible characters removed,
secrets masked (`docintel.redact`), `injection_guard`. Text flagged by the
scanner is not indexed at all: a node's metadata is what recall hands to an
agent, and an instruction hidden in a screenshot must not become one.

**The rebuild stays fast.** OCR costs a second an image, and the graph is
rebuilt after every write. So every answer is cached by the file's *content*
hash in ``.workpilot-brain/ocr-cache.json`` (git-ignored, like the graph: it is
derived, and two machines would conflict on it), a file whose size and mtime
did not change is not even re-hashed, and at most ``BRAIN_OCR_PER_BUILD`` new
images are read per rebuild — the next rebuild reads the next ones. A missing
engine is not cached: installing Tesseract later must be enough.

Nothing here raises. An image that cannot be read is a node with a reason.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .home import STATE_DIR

logger = logging.getLogger(__name__)

__all__ = [
    "CACHE_FILE",
    "ENABLED_ENV",
    "IMAGE_EXTENSIONS",
    "VaultImage",
    "cache_path",
    "iter_images",
    "index_images",
]

CACHE_FILE = f"{STATE_DIR}/ocr-cache.json"
ENABLED_ENV = "BRAIN_OCR_ENABLED"
MAX_IMAGES_ENV = "BRAIN_OCR_MAX_IMAGES"
PER_BUILD_ENV = "BRAIN_OCR_PER_BUILD"
DEFAULT_MAX_IMAGES = 300
DEFAULT_PER_BUILD = 10
#: What a node carries. The graph is read whole by every recall.
MAX_TEXT_CHARS = 2000

#: Pixels, and the diagram formats whose source is structured.
IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".bmp",
    ".tif",
    ".tiff",
    ".svg",
    ".drawio",
    ".excalidraw",
}
_STRUCTURED_ONLY = {".svg", ".drawio", ".excalidraw"}
_SKIP_DIRS = {".git", ".obsidian", ".trash", "graphify-out", ".brain"}
#: Why no engine answered that will not change until a person installs or
#: configures something: not cached, and the rest of the rebuild stops asking.
_NO_ENGINE = {
    "disabled",
    "no-engine",
    "unknown-engine",
    "not-installed",
    "not-configured",
    "airgap",
    "no-project",
}


@dataclass
class VaultImage:
    rel: str
    #: ``text`` read, ``withheld`` (injection / scanner unavailable), ``empty``
    #: nothing to read, ``pending`` not read yet (budget, no engine).
    status: str
    engine: str = ""
    text: str = ""
    date: str = ""
    reason: str = ""
    secrets: tuple[str, ...] = ()

    def metadata(self) -> dict[str, Any]:
        meta: dict[str, Any] = {"status": self.status}
        for key in ("engine", "text", "date", "reason"):
            value = getattr(self, key)
            if value:
                meta[key] = value
        if self.secrets:
            meta["secrets"] = list(self.secrets)
        return meta


def _flag(value: str | None) -> bool:
    return str(value or "true").strip().lower() not in ("false", "0", "no", "off")


def _int(value: str | None, default: int) -> int:
    try:
        number = int(str(value or "").strip())
    except ValueError:
        return default
    return number if number >= 0 else default


def cache_path(root: Path) -> Path:
    return root / CACHE_FILE


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return False
    return True


def iter_images(root: Path, limit: int | None = None):
    """Every image of the vault, relative paths, stable order, never a link.

    Same walk as the notes (`notes.iter_notes`): hidden folders, git and
    Graphify's output are not the vault's content. ``os.walk`` does not
    descend into a linked folder, and a linked file is skipped: a vault is
    somebody's folder, and a link inside it pointing at ``~/.ssh`` is not an
    image of theirs.
    """
    if not root.is_dir():
        return
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            d for d in dirnames if d not in _SKIP_DIRS and not d.startswith(".")
        )
        for name in sorted(filenames):
            if name.startswith(".") or Path(name).suffix.lower() not in (
                IMAGE_EXTENSIONS
            ):
                continue
            path = Path(dirpath) / name
            if path.is_symlink() or not path.is_file() or not _inside(path, root):
                continue
            yield path.relative_to(root)
            count += 1
            if limit is not None and count >= limit:
                return


def _load_cache(root: Path) -> dict[str, Any]:
    try:
        data = json.loads(cache_path(root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    if not isinstance(data, dict) or data.get("version") != 1:
        data = {}
    entries = data.get("entries")
    files = data.get("files")
    return {
        "version": 1,
        "entries": entries if isinstance(entries, dict) else {},
        "files": files if isinstance(files, dict) else {},
    }


def _save_cache(root: Path, cache: dict[str, Any]) -> None:
    target = cache_path(root)
    if target.is_symlink() or target.parent.is_symlink():
        return
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".ocr-", suffix=".json", dir=target.parent)
        replaced = False
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(cache, handle, ensure_ascii=False, indent=1)
                handle.write("\n")
            os.replace(tmp, target)
            replaced = True
        finally:
            # Whatever interrupted the write, no half-written temporary file
            # is left beside the cache.
            if not replaced:
                Path(tmp).unlink(missing_ok=True)
    except OSError:
        # A cache that cannot be written costs the next rebuild its OCR, not
        # this one its graph.
        logger.debug("brain: could not write the OCR cache", exc_info=True)


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _local_env() -> dict[str, str]:
    """docintel's settings, with the OCR chain cut down to local engines.

    The refusal of a cloud engine already happens in the chain when no project
    is given; filtering here as well means the rebuild never even logs a
    refusal warning, and a future change of that default cannot reach the
    vault.
    """
    from docintel import settings
    from docintel.engines import ENGINES

    env = settings.project_env(None)
    local = [
        name
        for name in settings.ocr_engines(env)
        if (engine := ENGINES.get(name)) is not None and engine.local
    ]
    env[settings.OCR_ENGINE_ENV] = ",".join(local) or "none"
    return env


def _protect(text: str) -> tuple[str, str, tuple[str, ...]]:
    """(text, status, secret kinds) — docintel's cleaning, masking and scan."""
    from docintel import redact
    from docintel.files import clean, threat

    text = clean(text).strip()
    if not text:
        return "", "empty", ()
    try:
        text, kinds = redact.redact_text(text)
    except redact.ScannerUnavailable:
        return "", "withheld", ()
    if threat(text, source="brain-image") != "safe":
        return "", "withheld", tuple(kinds)
    if len(text) > MAX_TEXT_CHARS:
        text = text[:MAX_TEXT_CHARS].rstrip() + "…"
    return text, "text", tuple(kinds)


def _read(path: Path, data: bytes, env: dict[str, str]) -> VaultImage | None:
    """What one file says; None when no engine could be asked (not cached)."""
    from docintel.diagrams import parse_diagram, render_diagram
    from docintel.ocr import ocr_image

    date = _now()
    diagram = parse_diagram(path, data)
    if diagram is not None and (diagram.nodes or diagram.edges):
        text, status, kinds = _protect(render_diagram(diagram))
        return VaultImage(
            rel="",
            status=status,
            engine=diagram.format,
            text=text,
            date=date,
            reason="injection" if status == "withheld" else "",
            secrets=kinds,
        )
    if path.suffix.lower() in _STRUCTURED_ONLY:
        return VaultImage(rel="", status="empty", date=date, reason="no-diagram")

    outcome = ocr_image(path, env, policy_paths=(), preview=True)
    if not outcome.text:
        if outcome.reason in _NO_ENGINE or outcome.reason == "deferred":
            return None
        return VaultImage(
            rel="",
            status="empty",
            engine=outcome.engine,
            date=date,
            reason=outcome.reason or "empty",
        )
    text, status, kinds = _protect(outcome.text)
    return VaultImage(
        rel="",
        status=status,
        engine=outcome.engine,
        text=text,
        date=date,
        reason="injection" if status == "withheld" else "",
        secrets=kinds,
    )


def _entry_image(rel: str, entry: dict[str, Any]) -> VaultImage:
    return VaultImage(
        rel=rel,
        status=str(entry.get("status") or "empty"),
        engine=str(entry.get("engine") or ""),
        text=str(entry.get("text") or ""),
        date=str(entry.get("date") or ""),
        reason=str(entry.get("reason") or ""),
        secrets=tuple(str(k) for k in entry.get("secrets") or []),
    )


def index_images(root: Path) -> list[VaultImage]:
    """Every image of the vault with what it says — from the cache when it can.

    Never raises: the graph must be buildable whatever happens here.
    """
    try:
        return _index(Path(root))
    except Exception:  # noqa: BLE001 - the graph is worth more than its images
        logger.debug("brain: image indexing failed", exc_info=True)
        return []


def _index(root: Path) -> list[VaultImage]:
    if not _flag(os.environ.get(ENABLED_ENV)):
        return []
    max_images = _int(os.environ.get(MAX_IMAGES_ENV), DEFAULT_MAX_IMAGES)
    budget = _int(os.environ.get(PER_BUILD_ENV), DEFAULT_PER_BUILD)
    rels = list(iter_images(root, limit=max_images))
    if not rels:
        if cache_path(root).is_file():
            _save_cache(root, {"version": 1, "entries": {}, "files": {}})
        return []

    from docintel import settings

    env = _local_env()
    max_bytes = settings.max_bytes(env)
    cache = _load_cache(root)
    entries: dict[str, Any] = cache["entries"]
    files: dict[str, Any] = cache["files"]
    fresh_files: dict[str, Any] = {}
    engines_missing = False
    changed = False
    out: list[VaultImage] = []

    for rel_path in rels:
        rel = rel_path.as_posix()
        path = root / rel_path
        try:
            stat = path.stat()
        except OSError:
            continue
        if stat.st_size > max_bytes:
            out.append(VaultImage(rel=rel, status="empty", reason="too-large"))
            continue

        known = files.get(rel) if isinstance(files.get(rel), dict) else None
        digest = ""
        data: bytes | None = None
        if (
            known
            and known.get("size") == stat.st_size
            and known.get("mtime_ns") == stat.st_mtime_ns
        ):
            digest = str(known.get("sha256") or "")
        if not digest:
            try:
                data = path.read_bytes()
            except OSError:
                continue
            digest = hashlib.sha256(data).hexdigest()
        fresh_files[rel] = {
            "size": stat.st_size,
            "mtime_ns": stat.st_mtime_ns,
            "sha256": digest,
        }

        entry = entries.get(digest)
        if isinstance(entry, dict):
            out.append(_entry_image(rel, entry))
            continue
        if engines_missing or budget <= 0:
            out.append(VaultImage(rel=rel, status="pending", reason="queued"))
            continue
        if data is None:
            try:
                data = path.read_bytes()
            except OSError:
                continue
        budget -= 1
        read = _read(path, data, env)
        if read is None:
            engines_missing = True
            out.append(VaultImage(rel=rel, status="pending", reason="no-engine"))
            continue
        read.rel = rel
        entries[digest] = {
            k: v for k, v in read.metadata().items() if k != "status"
        } | {"status": read.status}
        changed = True
        out.append(read)

    # Forget what no image of the vault points at any more: a cache that only
    # grows is a second copy of every screenshot ever deleted.
    live = {f["sha256"] for f in fresh_files.values()}
    stale = [key for key in entries if key not in live]
    for key in stale:
        del entries[key]
    if changed or stale or fresh_files != files:
        _save_cache(root, {"version": 1, "entries": entries, "files": fresh_files})
    return out
