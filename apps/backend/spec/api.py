"""What the spec left open, and what the plan will not build.

`traceability.json` is written once, when the implementation plan validates.
This endpoint answers the same question at any moment — including before there
is a plan at all, which is exactly when someone reading a task in the Kanban
wants to know how many `[NEEDS CLARIFICATION]` markers the spec still carries.

So the record is **recomputed** here rather than read back from the file. The
two agree during a build; they diverge in the two cases that matter, and the
live answer is the right one in both: a spec edited by hand after the build,
and a task that has not been planned yet.

Addressing goes through `core.api_safety.resolve_spec_dir`, the same rules as
every other endpoint: a bare `spec_id` under a project directory the user
chose in their own desktop app, or an explicit `spec_dir`.

**Local mode only, deliberately.** In server mode `_reject_client_supplied_paths`
refuses `project_dir` and `spec_dir` outright — a client naming a directory on a
shared server is a cross-tenant read — so this endpoint answers nothing there,
exactly like `workflows/api.py`. Serving it under a tenant would mean addressing
a task by `project_id` and letting the server resolve its own checkout; that is
a different endpoint, not a parameter on this one.
"""

from __future__ import annotations

import logging

from core.api_safety import SPEC_ADDRESS_REASONS, SpecAddressError, resolve_spec_dir
from fastapi import APIRouter, Query

from .traceability import collect

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/spec-traceability", tags=["spec-traceability"])


@router.get("/")
def spec_traceability(
    spec_dir: str | None = Query(None),
    project_dir: str | None = Query(None),
    spec_id: str | None = Query(None),
):
    """Requirements, open questions and requirement-to-subtask coverage."""
    try:
        resolved = resolve_spec_dir(spec_dir, project_dir, spec_id)
    except SpecAddressError as exc:
        # The detail carries a resolved filesystem path, so it goes to the log.
        # The caller gets the literal reason.
        logger.warning("invalid traceability request: %s", exc)
        return {
            "success": False,
            "error": SPEC_ADDRESS_REASONS.get(
                exc.reason, SPEC_ADDRESS_REASONS["addressing"]
            ),
            "reason": exc.reason,
        }

    try:
        return {"success": True, "traceability": collect(resolved)}
    except Exception:  # noqa: BLE001
        logger.exception("traceability collection failed")
        return {"success": False, "error": "An internal error has occurred."}
