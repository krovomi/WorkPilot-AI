"""HTTP routes for the Generational Test Archive.

Mounted at `/api/generational-tests`. Endpoints:

* `GET  /list?project_path=...`           — list all generations
* `POST /capture`                         — store a new generation from a test report
* `POST /compare`                         — diff a fresh report against a baseline

A report is the text of any stack's test report (JUnit XML, TRX, Jest/Vitest
JSON, ``go test -json``, ``cargo test`` output, Dart/Flutter JSON, RSpec JSON):
``reports.parse_report`` reads the format from the content. A run of the
project's own suite goes through ``runners/generational_tests_runner.py``.
* `DELETE /{label}?project_path=...`      — drop a stored generation
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from fastapi import APIRouter, Query
from foundation.api_safety import safe_error, validated_dir
from pydantic import BaseModel, Field

from .archive import GenerationalArchive
from .reports import MAX_REPORT_CHARS, ReportError, parse_report

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/generational-tests", tags=["generational-tests"])


def _validate_project_path(raw: str) -> Path:
    return validated_dir(raw, "project_path")


class CaptureRequest(BaseModel):
    project_path: str = Field(..., description="Project root.")
    label: str = Field(
        ..., description="Stable name for this generation (e.g. 'release-1.2.0')."
    )
    report: str = Field(
        ...,
        max_length=MAX_REPORT_CHARS,
        description="The test report's text, in any supported format.",
    )


class CompareRequest(BaseModel):
    project_path: str = Field(..., description="Project root.")
    baseline_label: str = Field(
        ..., description="Label of the generation to diff against."
    )
    report: str = Field(
        ...,
        max_length=MAX_REPORT_CHARS,
        description="The current run's test report, in any supported format.",
    )


@router.get("/list")
def list_generations(project_path: str = Query(...)):
    try:
        path = _validate_project_path(project_path)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "list_generations")}
    try:
        archive = GenerationalArchive(project_dir=path)
        details = archive.summaries()
        return {
            "success": True,
            "generations": [g["label"] for g in details],
            "details": details,
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("list_generations failed")
        return {"success": False, "error": safe_error(e, logger, "list_generations")}


@router.post("/capture")
def capture(req: CaptureRequest):
    try:
        path = _validate_project_path(req.project_path)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "capture")}
    try:
        archive = GenerationalArchive(project_dir=path)
        report_format, outcomes = parse_report(req.report, path)
        digest = hashlib.sha256(req.report.encode("utf-8")).hexdigest()[:16]
        gen = archive.capture(
            req.label, outcomes=outcomes, junit_source=f"{report_format}:{digest}"
        )
        return {
            "success": True,
            "label": gen.label,
            "format": report_format,
            "outcome_count": len(gen.outcomes),
            "passing_count": len(gen.passing_ids),
        }
    except ReportError as e:
        # A fixed code (``report.empty``…), never the report's own text.
        return {"success": False, "error": f"report.{e.code}"}
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "capture")}
    except Exception as e:  # noqa: BLE001
        logger.exception("capture failed")
        return {"success": False, "error": safe_error(e, logger, "capture")}


@router.post("/compare")
def compare(req: CompareRequest):
    try:
        path = _validate_project_path(req.project_path)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "compare")}
    try:
        archive = GenerationalArchive(project_dir=path)
        report_format, outcomes = parse_report(req.report, path)
        report = archive.compare(req.baseline_label, current_outcomes=outcomes)
        return {"success": True, "format": report_format, "report": report.to_dict()}
    except ReportError as e:
        # A fixed code (``report.empty``…), never the report's own text.
        return {"success": False, "error": f"report.{e.code}"}
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "compare")}
    except Exception as e:  # noqa: BLE001
        logger.exception("compare failed")
        return {"success": False, "error": safe_error(e, logger, "compare")}


@router.delete("/{label}")
def delete(label: str, project_path: str = Query(...)):
    try:
        path = _validate_project_path(project_path)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "delete")}
    try:
        archive = GenerationalArchive(project_dir=path)
        deleted = archive.delete(label)
        return {"success": True, "deleted": deleted}
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "delete")}
    except Exception as e:  # noqa: BLE001
        logger.exception("delete failed")
        return {"success": False, "error": safe_error(e, logger, "delete")}
