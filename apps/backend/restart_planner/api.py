"""HTTP routes for restart planning.

Mounted at `/api/restart`. Two endpoints:

* `GET  /plan?spec_dir=...`   — read-only, lists which restart modes are
  available + cleanup that would happen
* `POST /prepare`              — performs cleanup only (deletes
  intermediate files); never spawns an agent. The frontend triggers the
  actual restart via its existing IPC handlers.
"""

from __future__ import annotations

import logging
from pathlib import Path

from core.api_safety import safe_error, validated_dir
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .planner import RestartMode, plan_restart, prepare_restart

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/restart", tags=["restart"])


def _validate_spec_dir(raw: str) -> Path:
    return validated_dir(raw, "spec_dir")


@router.get("/plan")
def plan(spec_dir: str = Query(...)):
    """Inspect a spec and report which restart modes are available."""
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "plan")}
    try:
        result = plan_restart(sd)
        return {"success": True, "plan": result.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("plan_restart failed")
        return {"success": False, "error": safe_error(e, logger, "plan")}


class PrepareRequest(BaseModel):
    spec_dir: str = Field(..., description="Spec directory.")
    mode: str = Field(..., description="One of: qa, coder, full.")


@router.post("/prepare")
def prepare(req: PrepareRequest):
    """Run filesystem cleanup for the given mode. Returns deleted files.

    Does NOT spawn an agent — the frontend triggers that separately via
    its IPC handlers, after this endpoint has cleaned up stale state.
    """
    try:
        sd = _validate_spec_dir(req.spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "prepare")}

    try:
        mode = RestartMode(req.mode)
    except ValueError:
        return {
            "success": False,
            "error": (
                f"unknown restart mode {req.mode!r}; "
                f"valid: {[m.value for m in RestartMode]}"
            ),
        }

    try:
        result = prepare_restart(sd, mode)
        return {"success": True, **result}
    except Exception as e:  # noqa: BLE001
        logger.exception("prepare_restart failed")
        return {"success": False, "error": safe_error(e, logger, "prepare")}
