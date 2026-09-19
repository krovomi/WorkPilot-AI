"""HTTP routes for the i18n Auto-Scaler.

Mounted at `/api/i18n-scaler`. Endpoints:

* `POST /diff`              — diff a target locale against a source dict
* `POST /skeleton`          — generate a target locale skeleton from source
* `POST /report-from-dir`   — discover + report on a locales/ folder on disk
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from core.api_safety import safe_error, validated_dir
from fastapi import APIRouter
from pydantic import BaseModel, Field

from .scaler import I18nAutoScaler, PlaceholderStrategy

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/i18n-scaler", tags=["i18n-scaler"])


def _validate_dir(raw: str) -> Path:
    return validated_dir(raw, "path")


def _resolve_strategy(raw: str | None) -> PlaceholderStrategy:
    if not raw:
        return PlaceholderStrategy.LANG_PREFIX
    try:
        return PlaceholderStrategy(raw.lower())
    except ValueError as e:
        raise ValueError(
            f"unknown strategy {raw!r} (use lang_prefix | empty | source_value | marker)"
        ) from e


class DiffRequest(BaseModel):
    source: dict[str, Any] = Field(..., description="Source locale dict.")
    target: dict[str, Any] = Field(..., description="Target locale dict.")
    source_locale: str = Field("en", description="Source locale code.")
    target_locale: str = Field("fr", description="Target locale code.")


class SkeletonRequest(BaseModel):
    source: dict[str, Any] = Field(..., description="Source locale dict.")
    target_locale: str = Field(..., description="Target locale code (e.g. 'fr').")
    existing_target: dict[str, Any] | None = Field(
        None, description="If provided, existing translations are preserved."
    )
    placeholder_strategy: str | None = Field(
        None,
        description="lang_prefix | empty | source_value | marker. Default: lang_prefix.",
    )


class ReportFromDirRequest(BaseModel):
    locales_dir: str = Field(..., description="Path to the locales/ directory.")
    source_locale: str = Field("en", description="Locale to use as reference.")
    placeholder_strategy: str | None = Field(None)


@router.post("/diff")
def diff(req: DiffRequest):
    try:
        scaler = I18nAutoScaler()
        d = scaler.diff(req.source, req.target, req.source_locale, req.target_locale)
        return {"success": True, "diff": d.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("diff failed")
        return {"success": False, "error": safe_error(e, logger, "diff")}


@router.post("/skeleton")
def skeleton(req: SkeletonRequest):
    try:
        strategy = _resolve_strategy(req.placeholder_strategy)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "skeleton")}
    try:
        scaler = I18nAutoScaler(placeholder_strategy=strategy)
        out = scaler.generate_skeleton(
            req.source,
            target_locale=req.target_locale,
            existing_target=req.existing_target,
        )
        return {"success": True, "skeleton": out}
    except Exception as e:  # noqa: BLE001
        logger.exception("skeleton failed")
        return {"success": False, "error": safe_error(e, logger, "skeleton")}


@router.post("/report-from-dir")
def report_from_dir(req: ReportFromDirRequest):
    try:
        path = _validate_dir(req.locales_dir)
        strategy = _resolve_strategy(req.placeholder_strategy)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "report_from_dir")}
    try:
        scaler = I18nAutoScaler(placeholder_strategy=strategy)
        found = scaler.discover_locales(path)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "report_from_dir")}
    except Exception as e:  # noqa: BLE001
        logger.exception("report-from-dir discovery failed")
        return {"success": False, "error": safe_error(e, logger, "report_from_dir")}

    # Every refusal below names what was read and what was there. The one this
    # replaced said only that the source locale was not under the path — which
    # on the directory of that very locale read as a contradiction, and gave
    # nobody the one fact that settles it: which locales the scan did find.
    if not found.locales:
        return {
            "success": False,
            "error": (
                f"No translation files found under {path}. Expected either "
                f"{path.name}/<lang>/*.json or {path.name}/<lang>.json."
            ),
            "locales_dir": str(path),
            "locales_found": [],
        }

    if req.source_locale not in found.locales:
        available = ", ".join(sorted(found.locales))
        return {
            "success": False,
            "error": (
                f"Source locale {req.source_locale!r} not found in {found.root}. "
                f"Locales found: {available}."
            ),
            "locales_dir": str(found.root),
            "locales_found": sorted(found.locales),
        }

    try:
        report = scaler.report(req.source_locale, found.locales)
    except Exception as e:  # noqa: BLE001
        logger.exception("report-from-dir failed")
        return {"success": False, "error": safe_error(e, logger, "report_from_dir")}

    return {
        "success": True,
        "report": report.to_dict(),
        "locales_dir": str(found.root),
        "locales_found": sorted(found.locales),
        "layout": found.layout,
        # Set only when the caller named the inside of one language rather
        # than the root of all of them. The UI says so, because a report about
        # a directory nobody picked is worse than the error it replaces.
        "redirected_from": (
            str(found.redirected_from) if found.redirected_from is not None else None
        ),
    }
