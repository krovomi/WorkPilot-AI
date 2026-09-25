"""Read what was attached to a task, once, before planning.

The Kanban has always let a person attach screenshots, mockups and diagrams to
a task, copied them into `<spec_dir>/attachments/` and listed them in
`requirements.json` as `attached_images` — and no phase of the build read
either. The mockup a person took the trouble to attach reached nobody.

This runs where `libdocs.run_preflight` runs, with the same contract:

- **structured first** — a draw.io or Excalidraw file (or an export that hides
  one) is read as boxes and arrows, never OCR'd;
- **local only** — Tesseract when the machine has it, nothing sent anywhere;
  an image nobody transcribed is handed to the agents, which open it with the
  provider the task was configured for;
- **never fails a build** — every failure is a reason on the record.

The result lands in `<spec_dir>/docintel/`, next to the spec rather than in
the worktree, because "what did this task's attachments say" is asked after
the merge too.
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from . import settings
from .diagrams import parse_diagram, render_diagram
from .models import DocintelResult, ExtractedDocument
from .ocr import ocr_image

logger = logging.getLogger(__name__)

RESULT_DIR = "docintel"
RESULT_FILE = "result.json"
EXTRACTED_DIR = "extracted"
MAX_FILES = 25
#: What the record keeps inline; the full text is in `extracted/`.
EXCERPT_CHARS = 4000

TEXT_EXTENSIONS = {
    ".md",
    ".markdown",
    ".txt",
    ".adoc",
    ".rst",
    ".mmd",
    ".mermaid",
    ".puml",
    ".plantuml",
    ".log",
}
DOCUMENT_EXTENSIONS = {
    ".pdf",
    ".doc",
    ".docx",
    ".docm",
    ".odt",
    ".rtf",
    ".epub",
    ".ppt",
    ".pptx",
    ".odp",
    ".xls",
    ".xlsx",
    ".ods",
    ".csv",
}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff"}
DIAGRAM_EXTENSIONS = {".drawio", ".dio", ".excalidraw", ".svg", ".xml"}

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _inside(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
    except ValueError:
        return False
    return True


def attachment_paths(spec_dir: Path) -> list[Path]:
    """Every file attached to this task, each once, never outside the spec.

    Two sources, because the frontend writes both and they can disagree: the
    `attachments/` directory (what is on disk) and `attached_images` in
    `requirements.json` (what the task says it carries). A path in the latter
    that leaves the spec directory is ignored rather than followed.
    """
    found: list[Path] = []
    attachments = spec_dir / "attachments"
    if attachments.is_dir():
        found.extend(sorted(p for p in attachments.rglob("*") if p.is_file()))

    try:
        requirements = json.loads(
            (spec_dir / "requirements.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        requirements = {}
    for entry in requirements.get("attached_images") or []:
        relative = entry.get("path") if isinstance(entry, dict) else None
        if not relative:
            continue
        candidate = spec_dir / str(relative)
        if candidate.is_file() and _inside(candidate, spec_dir):
            found.append(candidate)

    unique: list[Path] = []
    seen: set[Path] = set()
    for path in found:
        key = path.resolve()
        if key not in seen and not _inside(path, spec_dir / RESULT_DIR):
            seen.add(key)
            unique.append(path)
    return unique[:MAX_FILES]


def _threat(text: str, source: str) -> str:
    try:
        from injection_guard import InjectionScanner

        return InjectionScanner().scan(text, source=source).threat_level.value
    except Exception:  # noqa: BLE001 - a scanner failure is not a verdict
        return "safe"


def _clean(text: str) -> str:
    try:
        from watermarks.clean import clean_generated

        return clean_generated(text).text
    except Exception:  # noqa: BLE001 - a cosmetic pass never blocks the read
        return text


def extract_file(path: Path, spec_dir: Path, env: dict[str, str]) -> ExtractedDocument:
    """What can be read out of one file without a model. Never raises."""
    try:
        relative = path.relative_to(spec_dir).as_posix()
    except ValueError:
        relative = path.name
    suffix = path.suffix.lower()

    try:
        size = path.stat().st_size
    except OSError:
        return ExtractedDocument(path=relative, status="skipped", reason="unreadable")
    if size > settings.max_bytes(env):
        return ExtractedDocument(path=relative, status="skipped", reason="too-large")

    if suffix in DOCUMENT_EXTENSIONS:
        # Office and PDF conversion is the document skill's job, and every
        # agent already carries it (`build_base_system_prompt`). Converting a
        # second way here would be two answers to one question.
        return ExtractedDocument(
            path=relative, status="document", reason="document-skill"
        )

    try:
        data = path.read_bytes()
    except OSError:
        return ExtractedDocument(path=relative, status="skipped", reason="unreadable")

    if suffix in DIAGRAM_EXTENSIONS | IMAGE_EXTENSIONS:
        diagram = parse_diagram(path, data)
        if diagram is not None:
            return ExtractedDocument(
                path=relative,
                status="diagram",
                engine=diagram.format,
                text=render_diagram(diagram),
                diagram=diagram,
            )

    if suffix in TEXT_EXTENSIONS:
        text = data.decode("utf-8", errors="replace").strip()
        if not text:
            return ExtractedDocument(path=relative, status="skipped", reason="empty")
        return ExtractedDocument(path=relative, status="text", engine="text", text=text)

    if suffix in IMAGE_EXTENSIONS:
        outcome = ocr_image(path, env)
        if outcome.text:
            return ExtractedDocument(
                path=relative, status="text", engine="tesseract", text=outcome.text
            )
        return ExtractedDocument(path=relative, status="image", reason=outcome.reason)

    if suffix == ".svg":
        return ExtractedDocument(path=relative, status="image", reason="no-diagram")
    return ExtractedDocument(path=relative, status="skipped", reason="unsupported")


def _write_extracted(doc: ExtractedDocument, spec_dir: Path) -> None:
    """The full text beside the record; the record keeps an excerpt."""
    if not doc.text:
        return
    name = _UNSAFE.sub("_", doc.path.replace("/", "__")).strip("_") or "document"
    target = spec_dir / RESULT_DIR / EXTRACTED_DIR / f"{name}.md"
    header = f"<!-- extracted from {doc.path} by {doc.engine or 'docintel'} -->\n\n"
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(header + doc.text + "\n", encoding="utf-8")
    except OSError:
        return
    doc.extracted_path = target.relative_to(spec_dir).as_posix()
    if len(doc.text) > EXCERPT_CHARS:
        doc.text = doc.text[:EXCERPT_CHARS].rstrip() + "\n…"


def run_preflight(
    spec_dir: Path,
    project_dir: Path | None = None,
    env: dict[str, str] | None = None,
    *,
    persist: bool = True,
) -> DocintelResult:
    """Read every attachment of the task and persist what was read.

    ``persist=False`` is the read the Kanban makes before any build: the same
    answer, nothing written — opening a panel is not a reason to create files
    in a spec directory.

    Never raises: the worst outcome is a record that says why nothing was read.
    """
    spec_dir = Path(spec_dir)
    env = settings.project_env(project_dir) if env is None else env
    if not settings.is_enabled(env):
        result = DocintelResult(skipped="disabled")
        return _discard(spec_dir, result) if persist else result

    paths = attachment_paths(spec_dir)
    if not paths:
        result = DocintelResult(skipped="no-attachments")
        return _discard(spec_dir, result) if persist else result

    result = DocintelResult()
    for path in paths:
        try:
            doc = extract_file(path, spec_dir, env)
        except Exception:  # noqa: BLE001 - one attachment, not the build
            logger.debug("docintel: extraction failed for %s", path, exc_info=True)
            doc = ExtractedDocument(path=path.name, status="skipped", reason="failed")
        if doc.text:
            doc.text = _clean(doc.text)
            doc.threat = _threat(doc.text, source=f"attachment:{doc.path}")
        if persist:
            _write_extracted(doc, spec_dir)
        elif len(doc.text) > EXCERPT_CHARS:
            doc.text = doc.text[:EXCERPT_CHARS].rstrip() + "\n…"
        result.documents.append(doc)
    return _persist(spec_dir, result) if persist else result


def _discard(spec_dir: Path, result: DocintelResult) -> DocintelResult:
    """Nothing to report: no record written, and a stale one removed.

    Most tasks attach nothing, and a `docintel/` directory in every spec saying
    so would be noise. A record left from before the attachments were removed
    would be worse — every phase would keep quoting files that are gone.
    """
    try:
        (spec_dir / RESULT_DIR / RESULT_FILE).unlink(missing_ok=True)
    except OSError:
        pass
    return result


def _persist(spec_dir: Path, result: DocintelResult) -> DocintelResult:
    target = spec_dir / RESULT_DIR / RESULT_FILE
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(result.to_dict(), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )
    except OSError:
        logger.debug("docintel: could not persist %s", target, exc_info=True)
    return result


def load_result(spec_dir: Path) -> DocintelResult | None:
    try:
        payload = json.loads(
            (Path(spec_dir) / RESULT_DIR / RESULT_FILE).read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    return DocintelResult.from_dict(payload) if isinstance(payload, dict) else None
