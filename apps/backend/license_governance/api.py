"""HTTP routes for the License Scanner.

Mounted at `/api/license-governance`. Three endpoints:

* `POST /scan`           — discover deps + classify + apply a policy
* `POST /classify`       — classify a single licence string (debugging helper)
* `POST /attribution`    — render an ATTRIBUTION.md from a scan
"""

from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter
from foundation.api_safety import safe_error, validated_dir
from pydantic import BaseModel, Field

from .attribution import (
    ATTRIBUTION_FILENAME,
    AttributionOptions,
    render_attribution,
    write_attribution,
)
from .local_metadata import LocalLicenseResolver
from .resolvers import LicenseResolution
from .scanner import (
    LicenseCategory,
    LicensePolicy,
    LicenseScanner,
    classify_license,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/license-governance", tags=["license-governance"])


def _validate_project_path(raw: str) -> Path:
    return validated_dir(raw, "project_path")


_POLICY_PRESETS = {
    "permissive_only": LicensePolicy.permissive_only,
    "open_source_friendly": LicensePolicy.open_source_friendly,
    "saas_safe": LicensePolicy.saas_safe,
}


class LicenseOverride(BaseModel):
    name: str
    license: str | None = None


class ScanRequest(BaseModel):
    project_path: str = Field(..., description="Project root.")
    policy: str = Field(
        "permissive_only",
        description=(
            "Preset policy: 'permissive_only' (MIT/BSD/Apache/...) | "
            "'open_source_friendly' (+ LGPL/MPL) | 'saas_safe' (alias of permissive_only, "
            "explicitly excludes AGPL)."
        ),
    )
    license_overrides: list[LicenseOverride] | None = Field(
        None,
        description=(
            "Per-package licence overrides — useful when callers already know "
            "a dep's licence (e.g. fetched from the registry). Maps name → licence."
        ),
    )
    online: bool = Field(
        True,
        description=(
            "Ask the public registries (deps.dev, npm, PyPI, Packagist, RubyGems, "
            "pub.dev) for licences no installed copy gives. Ignored (off) under a "
            "strict offline policy."
        ),
    )


def _resolution(
    project: Path, overrides: list[LicenseOverride] | None, online: bool
) -> LicenseResolution:
    """Manifest, installed copy, then registry — the last only when allowed.

    A project under a strict offline policy (``airgapStrict``) never reaches
    a registry, whatever the request says; an unreadable policy counts as
    strict.
    """
    try:
        from offline_policy import airgap_status

        airgapped = bool(airgap_status(project).get("airgapStrict"))
    except (OSError, ValueError):
        airgapped = True
    return LicenseResolution(
        local=LocalLicenseResolver(project),
        online=online and not airgapped,
        overrides={o.name: o.license for o in (overrides or [])},
    )


class ClassifyRequest(BaseModel):
    license: str = Field(..., description="Free-form licence string to classify.")


@router.post("/scan")
def scan(req: ScanRequest):
    try:
        path = _validate_project_path(req.project_path)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "scan")}

    if req.policy not in _POLICY_PRESETS:
        return {
            "success": False,
            "error": f"Unknown policy preset {req.policy!r}; choose one of {sorted(_POLICY_PRESETS)}.",
        }

    resolver = _resolution(path, req.license_overrides, req.online)
    try:
        scanner = LicenseScanner(
            project_dir=path,
            policy=_POLICY_PRESETS[req.policy](),
            resolver=resolver,
        )
        report = scanner.scan()
        return {"success": True, "online": resolver.online, "report": report.to_dict()}
    except Exception as e:  # noqa: BLE001
        logger.exception("license scan failed")
        return {"success": False, "error": safe_error(e, logger, "resolver")}


@router.post("/classify")
def classify(req: ClassifyRequest):
    try:
        cat = classify_license(req.license)
        return {
            "success": True,
            "license": req.license,
            "category": cat.value,
            "is_permissive": cat
            in (LicenseCategory.PERMISSIVE, LicenseCategory.PUBLIC_DOMAIN),
        }
    except Exception as e:  # noqa: BLE001
        logger.exception("classify failed")
        return {"success": False, "error": safe_error(e, logger, "classify")}


class AttributionRequest(BaseModel):
    project_path: str = Field(..., description="Project root.")
    project_name: str | None = Field(
        None,
        description="Display name in the generated header. Defaults to the project dir name.",
    )
    include_transitive: bool = True
    include_unknown: bool = True
    write_to_disk: bool = Field(
        False,
        description=f"If true, write {ATTRIBUTION_FILENAME} at the project root.",
    )
    license_overrides: list[LicenseOverride] | None = None
    online: bool = True


@router.post("/attribution")
def attribution(req: AttributionRequest):
    try:
        path = _validate_project_path(req.project_path)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "attribution")}

    resolver = _resolution(path, req.license_overrides, req.online)
    try:
        scanner = LicenseScanner(project_dir=path, resolver=resolver)
        report = scanner.scan()
        opts = AttributionOptions(
            project_name=req.project_name or path.name,
            include_transitive=req.include_transitive,
            include_unknown=req.include_unknown,
        )
        markdown = render_attribution(report, opts)
        result: dict = {
            "success": True,
            "attribution_md": markdown,
            "dependency_count": len(report.dependencies),
        }
        if req.write_to_disk:
            written = write_attribution(report, path, opts)
            result["written_to"] = str(written)
        return result
    except Exception as e:  # noqa: BLE001
        logger.exception("attribution generation failed")
        return {"success": False, "error": safe_error(e, logger, "resolver")}
