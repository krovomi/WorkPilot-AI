"""HTTP route for the fine-grained progress indicator."""

from __future__ import annotations

import logging
from pathlib import Path

from core.api_safety import safe_error, validated_dir
from fastapi import APIRouter, Query

from .builder import build_progress_indicator

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/progress-indicator", tags=["progress-indicator"])


def _validate_spec_dir(raw: str) -> Path:
    return validated_dir(raw, "spec_dir")


@router.get("/")
def indicator(spec_dir: str = Query(...)):
    """Return the fine-grained progress label for a spec."""
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "indicator")}

    try:
        snap = build_progress_indicator(sd)
        return {"success": True, "indicator": snap.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("build_progress_indicator failed")
        return {"success": False, "error": safe_error(e, logger, "indicator")}
