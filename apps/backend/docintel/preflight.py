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

from . import redact, settings
from .diagnostics import diagnose
from .diagrams import parse_diagram, render_diagram
from .models import DocintelResult, ExtractedDocument
from .ocr import OcrOutcome, ocr_image
from .stacktrace import RepoIndex

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
        # A symlink is never followed: `attachments/` is the task's own copy of
        # what was attached, and a link inside it pointing at `~/.ssh` would
        # otherwise be read into a prompt.
        found.extend(
            sorted(
                p
                for p in attachments.rglob("*")
                if p.is_file() and not p.is_symlink() and _inside(p, spec_dir)
            )
        )

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
        if (
            candidate.is_file()
            and not candidate.is_symlink()
            and _inside(candidate, spec_dir)
        ):
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


def extract_file(
    path: Path,
    spec_dir: Path,
    env: dict[str, str],
    *,
    policy_paths: tuple[Path, ...] = (),
    preview: bool = True,
) -> ExtractedDocument:
    """What can be read out of one file without a model. Never raises.

    The text comes back already cleaned, with its secrets masked and its
    threat level set — the same protection `run_preflight` applies, minus the
    redacted copy of an image, which only a persisting read writes.

    ``preview=False`` lets the vision and cloud engines of the chain answer
    too (still subject to the airgap policy of ``policy_paths``): a caller
    that is doing the work now, not a panel guessing what a build will do.
    """
    doc, outcome = _extract(path, spec_dir, env, policy_paths, preview=preview)
    return _protect(doc, outcome, path, spec_dir, persist=False)


def _diagnose_document(
    doc: ExtractedDocument, project_dir: Path | None, index: RepoIndex | None
) -> None:
    """A crash or a red pipeline in the text, located in the repository.

    Only text that passed every check: a diagram's labels are not a log, and
    text flagged as an injection is not read further by anything.
    """
    if not doc.text or doc.threat != "safe" or doc.status == "diagram":
        return
    doc.diagnosis = diagnose(doc.text, project_dir, index)


def _description_diagnosis(
    spec_dir: Path, project_dir: Path | None, index: RepoIndex | None
) -> dict | None:
    """A trace pasted into the task itself — through the same checks as an attachment.

    The description is often not the person's own text: an imported Jira
    ticket, a GitHub issue. So its secrets are masked and it is scanned before
    anything is read out of it.
    """
    try:
        requirements = json.loads(
            (spec_dir / "requirements.json").read_text(encoding="utf-8")
        )
    except (OSError, ValueError):
        return None
    text = (
        requirements.get("task_description") if isinstance(requirements, dict) else None
    )
    if not isinstance(text, str) or not text.strip():
        return None
    try:
        text, _kinds = redact.redact_text(_clean(text))
    except redact.ScannerUnavailable:
        return None
    if _threat(text, source="task-description") != "safe":
        return None
    return diagnose(text, project_dir, index)


def _extract(
    path: Path,
    spec_dir: Path,
    env: dict[str, str],
    policy_paths: tuple[Path, ...],
    *,
    preview: bool,
) -> tuple[ExtractedDocument, OcrOutcome | None]:
    try:
        relative = path.relative_to(spec_dir).as_posix()
    except ValueError:
        relative = path.name
    suffix = path.suffix.lower()

    try:
        size = path.stat().st_size
    except OSError:
        return _doc(relative, "skipped", reason="unreadable")
    if size > settings.max_bytes(env):
        return _doc(relative, "skipped", reason="too-large")

    if suffix in DOCUMENT_EXTENSIONS:
        # Office and PDF conversion is the document skill's job, and every
        # agent already carries it (`build_base_system_prompt`). Converting a
        # second way here would be two answers to one question.
        return _doc(relative, "document", reason="document-skill")

    try:
        data = path.read_bytes()
    except OSError:
        return _doc(relative, "skipped", reason="unreadable")

    if suffix in DIAGRAM_EXTENSIONS | IMAGE_EXTENSIONS:
        diagram = parse_diagram(path, data)
        if diagram is not None:
            doc = ExtractedDocument(
                path=relative,
                status="diagram",
                engine=diagram.format,
                text=render_diagram(diagram),
                diagram=diagram,
            )
            return doc, None

    if suffix in TEXT_EXTENSIONS:
        text = data.decode("utf-8", errors="replace").strip()
        if not text:
            return _doc(relative, "skipped", reason="empty")
        return _doc(relative, "text", engine="text", text=text)

    if suffix in IMAGE_EXTENSIONS:
        outcome = ocr_image(path, env, policy_paths=policy_paths, preview=preview)
        doc = ExtractedDocument(
            path=relative,
            status="text" if outcome.text else "image",
            engine=outcome.engine if outcome.text else "",
            text=outcome.text,
            reason="" if outcome.text else outcome.reason,
            attempts=list(outcome.attempts),
            described=outcome.described,
        )
        return doc, outcome

    if suffix == ".svg":
        return _doc(relative, "image", reason="no-diagram")
    return _doc(relative, "skipped", reason="unsupported")


def _doc(relative: str, status: str, **fields) -> tuple[ExtractedDocument, None]:
    return ExtractedDocument(path=relative, status=status, **fields), None


def _mask_diagram(doc: ExtractedDocument) -> list[str]:
    """Secrets in a diagram's labels: the model is persisted as well as the
    rendered text, and a box labelled with a connection string is both."""
    if doc.diagram is None:
        return []
    found: list[str] = []
    for item in [*doc.diagram.nodes, *doc.diagram.edges]:
        if item.label:
            item.label, item_kinds = redact.redact_text(item.label)
            found.extend(item_kinds)
    return found


def _protect(
    doc: ExtractedDocument,
    outcome: OcrOutcome | None,
    path: Path,
    spec_dir: Path,
    *,
    persist: bool,
) -> ExtractedDocument:
    """Clean, mask, scan — and decide what an agent may see of an image.

    The order matters. Invisible characters go first, because a zero-width
    space inside a key is how a key slips past a pattern. Secrets are masked
    before the injection scan, so the scanner's own report cannot quote one.
    And an image is only repainted once both scans are done: an image flagged
    as an injection is withheld, and painting a copy nobody will be pointed at
    would leave a file behind for nothing.
    """
    if not doc.text:
        return doc
    doc.text = _clean(doc.text)
    from_image = outcome is not None and bool(outcome.text)

    try:
        findings = redact.find_secrets(doc.text)
        diagram_kinds = _mask_diagram(doc)
    except redact.ScannerUnavailable:
        # Fail closed: "could not check for secrets" must not read as "none".
        logger.warning(
            "docintel: secret patterns unavailable; withholding %s", doc.path
        )
        doc.text = ""
        doc.diagram = None
        doc.status = "withheld"
        doc.reason = "secret-scan-unavailable"
        return doc

    doc.text = redact.mask_text(doc.text, findings)
    doc.secrets = sorted({*redact.kinds(findings), *diagram_kinds})
    doc.threat = _threat(doc.text, source=f"attachment:{doc.path}")

    if not from_image:
        return doc
    if doc.threat != "safe":
        # Text in an image that reads like an order to the agent: the image is
        # the carrier, so the image goes nowhere — not only its transcription.
        doc.status, doc.reason = "withheld", "injection"
        return doc
    if not findings:
        return doc

    boxes = redact.covering_boxes(outcome.boxes, findings)
    if boxes is None:
        doc.status, doc.reason = "withheld", "secret-no-boxes"
    elif not redact.pillow_available():
        doc.status, doc.reason = "withheld", "secret-no-pillow"
    elif not persist:
        # The panel's read: what the build will do, nothing written.
        doc.status, doc.reason = "redacted", ""
    else:
        name = _UNSAFE.sub("_", doc.path.replace("/", "__")).strip("_") or "image"
        target = spec_dir / RESULT_DIR / redact.REDACTED_DIR / f"{name}.png"
        if _writable(target, spec_dir) and redact.write_redacted_image(
            path, boxes, target
        ):
            doc.status, doc.reason = "redacted", ""
            doc.redacted_path = target.relative_to(spec_dir).as_posix()
        else:
            doc.status, doc.reason = "withheld", "redaction-failed"
    return doc


def _writable(target: Path, spec_dir: Path) -> bool:
    """Whether `target` can be written without leaving the spec directory.

    Nothing on the way to it may be a symlink — `docintel/`, `extracted/` or
    the file itself: a spec directory copied from somewhere else, or edited by
    hand, could carry one pointing at a file the build must never overwrite.
    """
    current = target
    while current != spec_dir and spec_dir in current.parents:
        if current.is_symlink():
            return False
        current = current.parent
    return _inside(target.parent, spec_dir) if target.parent.exists() else True


def _write_extracted(doc: ExtractedDocument, spec_dir: Path) -> None:
    """The full text beside the record; the record keeps an excerpt."""
    if not doc.text:
        return
    name = _UNSAFE.sub("_", doc.path.replace("/", "__")).strip("_") or "document"
    target = spec_dir / RESULT_DIR / EXTRACTED_DIR / f"{name}.md"
    header = f"<!-- extracted from {doc.path} by {doc.engine or 'docintel'} -->\n\n"
    if not _writable(target, spec_dir):
        logger.warning("docintel: refusing to write through a symlink: %s", target)
        return
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

    # One index of the repository for every trace in this task, built only if
    # one of them needs it.
    index = RepoIndex(Path(project_dir)) if project_dir is not None else None
    described = _description_diagnosis(spec_dir, project_dir, index)

    paths = attachment_paths(spec_dir)
    if not paths and not described:
        result = DocintelResult(skipped="no-attachments")
        return _discard(spec_dir, result) if persist else result

    policy_paths = tuple(Path(p) for p in (spec_dir, project_dir) if p is not None)
    result = DocintelResult(description_diagnosis=described)
    for path in paths:
        try:
            doc, outcome = _extract(
                path, spec_dir, env, policy_paths, preview=not persist
            )
            doc = _protect(doc, outcome, path, spec_dir, persist=persist)
            _diagnose_document(doc, project_dir, index)
        except Exception:  # noqa: BLE001 - one attachment, not the build
            logger.debug("docintel: extraction failed for %s", path, exc_info=True)
            doc = ExtractedDocument(path=path.name, status="skipped", reason="failed")
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
        # A record that cannot be removed is stale, not fatal: the next build
        # that has attachments overwrites it.
        logger.debug("docintel: could not remove a stale record", exc_info=True)
    return result


def _persist(spec_dir: Path, result: DocintelResult) -> DocintelResult:
    target = spec_dir / RESULT_DIR / RESULT_FILE
    if not _writable(target, spec_dir):
        logger.warning("docintel: refusing to write through a symlink: %s", target)
        return result
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


def read_capture(path: Path, project_dir: Path | None) -> ExtractedDocument:
    """A screenshot or log of a failed pipeline, read the way an attachment is.

    Same chain, same checks: OCR from `DOCINTEL_OCR_ENGINE` under the project's
    airgap policy, secrets masked, text scanned by `injection_guard`. Returns
    the `ExtractedDocument`; its `text` is what may be used, and a ``withheld``
    status for an injection means nothing of it may be.
    """
    path = Path(path)
    if path.is_symlink() or not path.is_file():
        return ExtractedDocument(path=path.name, status="skipped", reason="unreadable")
    env = settings.project_env(project_dir)
    policy = tuple(Path(p) for p in (project_dir,) if p is not None)
    return extract_file(path, path.parent, env, policy_paths=policy, preview=False)
