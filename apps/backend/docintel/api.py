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
from .conformance import check_conformance
from .preflight import run_preflight

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/docintel", tags=["docintel"])


def project_of(spec_dir: Path) -> Path | None:
    """`<project>/.workpilot/specs/<id>` -> `<project>`, or None."""
    if spec_dir.parent.name == "specs" and spec_dir.parent.parent.name == ".workpilot":
        return spec_dir.parent.parent.parent
    return None


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
        }
    except Exception:  # noqa: BLE001
        logger.exception("docintel collection failed")
        return {"success": False, "error": "An internal error has occurred."}
