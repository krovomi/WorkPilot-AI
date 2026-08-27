"""HTTP routes for local-Arena variations."""

from __future__ import annotations

import logging
from pathlib import Path

from core.api_safety import safe_error, validated_dir
from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from .planner import compare_variations, create_variations, list_variations

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/parallel-variations", tags=["parallel-variations"])


def _validate_spec_dir(raw: str) -> Path:
    return validated_dir(raw, "spec_dir")


@router.get("/list")
def list_endpoint(spec_dir: str = Query(...)):
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "list_endpoint")}
    return {"success": True, "manifest": list_variations(sd).to_dict()}


class CreateRequest(BaseModel):
    spec_dir: str = Field(...)
    count: int = Field(..., ge=1)


@router.post("/create")
def create_endpoint(req: CreateRequest):
    try:
        sd = _validate_spec_dir(req.spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "create_endpoint")}
    try:
        manifest = create_variations(sd, req.count)
        return {"success": True, "manifest": manifest.to_dict()}
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "create_endpoint")}
    except Exception as e:  # noqa: BLE001
        logger.exception("create_variations failed")
        return {"success": False, "error": safe_error(e, logger, "create_endpoint")}


@router.get("/compare")
def compare_endpoint(spec_dir: str = Query(...)):
    try:
        sd = _validate_spec_dir(spec_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "compare_endpoint")}
    try:
        return {"success": True, "comparison": compare_variations(sd).to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("compare_variations failed")
        return {"success": False, "error": safe_error(e, logger, "compare_endpoint")}
