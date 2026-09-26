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

from .adr import collect_adrs
from .api_tests import draft_tests
from .conformance import check_conformance
from .erd import check_erd
from .preflight import run_preflight
from .sequence import check_sequences

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
            "documents": [d.to_dict() for d in result.documents],
            "skipped": result.skipped,
            "adrs": [a.to_dict() for a in adrs],
            "conformance": (
                check_conformance(project).to_dict() if project is not None else None
            ),
            **(_safe_code_checks(project, resolved) if project is not None else {}),
        }
    except Exception:  # noqa: BLE001
        logger.exception("docintel collection failed")
        return {"success": False, "error": "An internal error has occurred."}
