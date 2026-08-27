"""HTTP routes for QA auto-promotion.

Mounted at `/api/qa-promotion`. Two endpoints:

* `GET  /score?spec_dir=...`   — compute the QA confidence score (read-only)
* `POST /decide`               — score + apply the threshold (still no UI mutation)

The Kanban frontend uses these to decide whether to auto-skip the
``human_review`` column. The mutation (moving the card) is the
frontend's responsibility — backend stays read-only here.
"""

from __future__ import annotations

import logging
from pathlib import Path

from core.api_safety import safe_error, validated_dir
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .promoter import compute_qa_score, decide_promotion

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/qa-promotion", tags=["qa-promotion"])


def _validate_spec_dir(raw: str) -> Path:
    return validated_dir(raw, "spec_dir")


@router.get("/score")
def score(spec_dir: str = Query(...)):
    """Return the QA confidence score for the spec (no decision applied)."""
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "score")}
    try:
        score_value, breakdown, reasons = compute_qa_score(sd)
        return {
            "success": True,
            "score": score_value,
            "breakdown": breakdown,
            "reasons": reasons,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("compute_qa_score failed")
        return {"success": False, "error": safe_error(e, logger, "score")}


class DecideRequest(BaseModel):
    spec_dir: str = Field(..., description="Spec directory to evaluate.")


@router.post("/decide")
def decide(req: DecideRequest):
    """Compute score + apply the configured threshold."""
    try:
        sd = _validate_spec_dir(req.spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "decide")}
    try:
        decision = decide_promotion(sd)
        return {"success": True, "decision": decision.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("decide_promotion failed")
        return {"success": False, "error": safe_error(e, logger, "decide")}
