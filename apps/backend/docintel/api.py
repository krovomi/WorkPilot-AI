"""What the agents will read from a task's attachments and the project's ADRs.

`GET /api/docintel/` answers it at any moment, including before the task has
ever been built — which is when someone looking at a card wants to know
whether the diagram they attached will be understood. So the answer is
**recomputed**, like `spec/api.py`, with nothing written: the preflight writes
its record when a build starts, not when a panel opens.

Refused in server mode by the same addressing rules as every spec endpoint
(`core.api_safety.resolve_spec_dir`): a client naming a directory on a shared
server is a cross-tenant read.
"""

from __future__ import annotations

import logging
from pathlib import Path

from core.api_safety import SPEC_ADDRESS_REASONS, SpecAddressError, resolve_spec_dir
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from . import settings
from .adr import collect_adrs
from .api_tests import draft_tests
from .conformance import check_conformance
from .diagnostics import summary
from .erd import check_erd
from .preflight import run_preflight
from .sequence import check_sequences
from .spec_drafts import decide, load_drafts
from .whiteboard import convert

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/docintel", tags=["docintel"])


def project_of(spec_dir: Path) -> Path | None:
    """`<project>/.workpilot/specs/<id>` -> `<project>`, or None."""
    if spec_dir.parent.name == "specs" and spec_dir.parent.parent.name == ".workpilot":
        return spec_dir.parent.parent.parent
    return None


def _code_checks(project: Path, spec_dir: Path) -> dict:
    """ERD vs. ORM, sequences vs. code, HTTP captures -> tests: the counts the card shows.

    Each one returns before touching the code when there is no source for it,
    which is what makes asking on every panel opening affordable.
    """
    out: dict = {}
    erd = check_erd(project, spec_dir)
    checked = [c for c in erd.checks if c.status == "checked"]
    if checked:
        out["erd"] = {
            "diagrams": [{"path": c.erd, "origin": c.origin} for c in checked],
            "findings": len(erd.findings),
            "kinds": sorted({f.kind for f in erd.findings}),
            "ambiguous": sum(len(c.ambiguous) for c in checked),
        }
    sequences = [c for c in check_sequences(project, spec_dir).checks if c.calls]
    if sequences:
        out["sequences"] = [
            {
                "path": c.diagram,
                "origin": c.origin,
                "verified": c.verified,
                "checkable": c.checkable,
            }
            for c in sequences
        ]
    drafts = draft_tests(project, spec_dir)
    if drafts:
        out["apiTests"] = [
            {
                "method": exchange.method,
                "path": exchange.path,
                "status": exchange.status,
                "origin": exchange.origin,
                "destination": draft.path if draft else "",
                "stack": draft.stack if draft else "",
            }
            for exchange, draft in drafts
        ]
    return out


def _safe_code_checks(project: Path, spec_dir: Path) -> dict:
    """The attachments and ADRs are the card's first answer; these never cost it."""
    try:
        return _code_checks(project, spec_dir)
    except Exception:  # noqa: BLE001
        logger.debug("docintel code checks failed", exc_info=True)
        return {}


@router.get("/")
def docintel(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    """Attachments as the agents will receive them, and the project's ADRs."""
    try:
        resolved = resolve_spec_dir(spec_dir, project_dir, spec_id)
    except SpecAddressError as exc:
        logger.warning("invalid docintel request: %s", exc)
        return {
            "success": False,
            "error": SPEC_ADDRESS_REASONS.get(
                exc.reason, SPEC_ADDRESS_REASONS["addressing"]
            ),
            "reason": exc.reason,
        }

    try:
        project = project_of(resolved)
        result = run_preflight(resolved, project, persist=False)
        adrs = collect_adrs(project) if project is not None else []
        return {
            "success": True,
            "documents": [
                {**d.to_dict(), "diagnosis_summary": summary(d.diagnosis)}
                for d in result.documents
            ],
            "skipped": result.skipped,
            "description_diagnosis": summary(result.description_diagnosis),
            "adrs": [a.to_dict() for a in adrs],
            "conformance": (
                check_conformance(project).to_dict() if project is not None else None
            ),
            **(_safe_code_checks(project, resolved) if project is not None else {}),
        }
    except Exception:  # noqa: BLE001
        logger.exception("docintel collection failed")
        return {"success": False, "error": "An internal error has occurred."}


# ---------------------------------------------------------------------------
# Drafts: requirements, criteria and rule tables proposed from the attachments
# ---------------------------------------------------------------------------


class SpecAddress(BaseModel):
    spec_dir: str | None = None
    project_dir: str | None = None
    spec_id: str | None = None


class DraftDecision(SpecAddress):
    #: Draft key -> the text the person kept (their edit, or the proposal).
    accept_requirements: dict[str, str] = Field(default_factory=dict)
    reject_requirements: list[str] = Field(default_factory=list)
    accept_criteria: dict[str, str] = Field(default_factory=dict)
    reject_criteria: list[str] = Field(default_factory=list)
    reject_tables: list[str] = Field(default_factory=list)


class WhiteboardRequest(SpecAddress):
    #: The photo, relative to the spec directory (`attachments/board.jpg`).
    path: str


def _resolve(address: SpecAddress) -> tuple[Path | None, dict | None]:
    try:
        return (
            resolve_spec_dir(address.spec_dir, address.project_dir, address.spec_id),
            None,
        )
    except SpecAddressError as exc:
        logger.warning("invalid docintel request: %s", exc)
        return None, {
            "success": False,
            "error": SPEC_ADDRESS_REASONS.get(
                exc.reason, SPEC_ADDRESS_REASONS["addressing"]
            ),
            "reason": exc.reason,
        }


def _vision(spec_dir: Path, project: Path | None) -> dict:
    """Whether a photo can be turned into a diagram here, and why not.

    Asked only when the task has an image: the probe is a loopback call to
    Ollama (cached a minute), and a task without a photo has nothing to offer.
    """
    from .engines.ollama_vision import OllamaVisionEngine
    from .preflight import IMAGE_EXTENSIONS, attachment_paths

    images = [
        p.relative_to(spec_dir).as_posix()
        for p in attachment_paths(spec_dir)
        if p.suffix.lower() in IMAGE_EXTENSIONS
    ]
    if not images:
        return {"images": [], "available": False, "reason": "no-image"}
    env = settings.project_env(project)
    if not settings.local_ocr_enabled(env):
        return {"images": images, "available": False, "reason": "disabled"}
    reason = OllamaVisionEngine().available(env)
    return {
        "images": images,
        "available": reason is None,
        "reason": reason or "",
        "model": settings.vision_model(env),
    }


def _drafts_payload(spec_dir: Path, project: Path | None) -> dict:
    from .pdf import backends
    from .preflight import IMAGE_EXTENSIONS, SPEC_SOURCE_EXTENSIONS, attachment_paths

    drafts = load_drafts(spec_dir)
    readable = [
        p.relative_to(spec_dir).as_posix()
        for p in attachment_paths(spec_dir)
        if p.suffix.lower() in SPEC_SOURCE_EXTENSIONS | IMAGE_EXTENSIONS
    ]
    return {
        "success": True,
        "drafts": drafts.to_dict() if drafts else None,
        "pending": drafts.pending if drafts else 0,
        "readable": readable,
        "pdfBackends": backends(),
        "vision": _vision(spec_dir, project),
    }


@router.get("/drafts")
def drafts(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    """What the attachments propose, and what the person already decided."""
    resolved, error = _resolve(
        SpecAddress(spec_dir=spec_dir, project_dir=project_dir, spec_id=spec_id)
    )
    if error:
        return error
    try:
        return _drafts_payload(resolved, project_of(resolved))
    except Exception:  # noqa: BLE001
        logger.exception("docintel drafts failed")
        return {"success": False, "error": "An internal error has occurred."}


@router.post("/drafts/extract")
def extract_drafts(address: SpecAddress):
    """Read the attachments now — the build's own preflight, on request.

    This is the one place outside a build where the OCR of a scanned PDF runs:
    a person pressed the button and is waiting for it. It writes what a build
    writes (`result.json`, `extracted/`, `drafts.json`), and nothing else.
    """
    resolved, error = _resolve(address)
    if error:
        return error
    try:
        project = project_of(resolved)
        run_preflight(resolved, project, persist=True)
        return _drafts_payload(resolved, project)
    except Exception:  # noqa: BLE001
        logger.exception("docintel draft extraction failed")
        return {"success": False, "error": "An internal error has occurred."}


@router.post("/drafts/decide")
def decide_drafts(body: DraftDecision):
    """Accept or reject proposals. Accepted requirements go into `spec.md`."""
    resolved, error = _resolve(body)
    if error:
        return error
    try:
        decision = decide(
            resolved,
            accept_requirements=body.accept_requirements,
            reject_requirements=body.reject_requirements,
            accept_criteria=body.accept_criteria,
            reject_criteria=body.reject_criteria,
            reject_tables=body.reject_tables,
        )
        return {
            **_drafts_payload(resolved, project_of(resolved)),
            "decision": decision.to_dict(),
        }
    except Exception:  # noqa: BLE001
        logger.exception("docintel draft decision failed")
        return {"success": False, "error": "An internal error has occurred."}


@router.post("/whiteboard")
def whiteboard(body: WhiteboardRequest):
    """A whiteboard photo of this task, as an editable `.drawio` beside it."""
    resolved, error = _resolve(body)
    if error:
        return error
    from .preflight import attachment_paths

    # The photo is *chosen* among the task's own attachments, never built from
    # the request: a path the client sends is a name to look up, not a path to
    # open, so nothing on disk is touched on its say-so.
    wanted = body.path.replace("\\", "/")
    attached = {
        p.relative_to(resolved).as_posix(): p for p in attachment_paths(resolved)
    }
    image = attached.get(wanted)
    if image is None:
        return {
            "success": False,
            "error": "Not an attachment of this task.",
            "reason": "path",
        }
    try:
        project = project_of(resolved)
        result = convert(resolved, image, project)
        return {"success": True, "result": result.to_dict()}
    except Exception:  # noqa: BLE001
        logger.exception("docintel whiteboard conversion failed")
        return {"success": False, "error": "An internal error has occurred."}
