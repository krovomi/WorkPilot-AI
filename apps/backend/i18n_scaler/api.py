"""HTTP routes for the i18n Auto-Scaler.

Mounted at `/api/i18n-scaler`. Endpoints:

* `POST /diff`              — diff a target locale against a source dict
* `POST /skeleton`          — generate a target locale skeleton from source
* `POST /report-from-dir`   — discover + report on a locales/ folder on disk

And the editor, which is the half that writes:

* `POST /detect`            — the translation directories inside a project
* `POST /namespaces`        — every namespace, with per-locale completeness
* `POST /namespace`         — one namespace across every locale, editable
* `POST /mutate`            — apply a batch of edits to the JSON files

The editor is **refused in server mode**, like `workflows/api.py` and
`hermes/api.py`. It takes a filesystem path from the request and writes to it;
on a shared deployment that is a cross-tenant write, and the repository's own
rule is that a client-supplied path is refused outright there. Confining it to
`REPOS_ROOT` would not be enough — every tenant's checkout is under it.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from core.api_safety import safe_error, server_mode_roots, validated_dir
from fastapi import APIRouter
from pydantic import BaseModel, Field

from .editor import (
    EditorError,
    Operation,
    StaleFileError,
    apply_operations,
    find_locale_roots,
    list_namespaces,
    load_namespace,
)
from .scaler import I18nAutoScaler, PlaceholderStrategy

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/i18n-scaler", tags=["i18n-scaler"])


def _validate_dir(raw: str) -> Path:
    return validated_dir(raw, "path")


_SERVER_MODE_REFUSAL = (
    "The translation editor is not available in server mode: it reads and "
    "writes a directory named by the caller, which on a shared deployment is "
    "another tenant's checkout."
)


def _refused_in_server_mode() -> dict | None:
    """`None` in local mode. The refusal payload otherwise."""
    if server_mode_roots() is None:
        return None
    return {"success": False, "error": _SERVER_MODE_REFUSAL}


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


# ----------------------------------------------------------------------
# The editor


class NamespacesRequest(BaseModel):
    locales_dir: str = Field(..., description="Path to the locales/ directory.")


class NamespaceRequest(BaseModel):
    locales_dir: str = Field(..., description="Path to the locales/ directory.")
    namespace: str = Field(
        "", description="Namespace stem. Empty for a flat <root>/<lang>.json layout."
    )
    reference_locale: str | None = Field(
        None,
        description=(
            "Whose interpolation variables the other locales are checked "
            "against. Defaults to the first locale alphabetically."
        ),
    )


class OperationModel(BaseModel):
    op: str = Field(..., description="set | add | rename | delete")
    key: str = Field(..., description="Dotted key path inside the namespace.")
    new_key: str | None = Field(None, description="Required by `rename`.")
    values: dict[str, str | None] = Field(
        default_factory=dict,
        description=(
            "Locale → value, for `set` and `add`. A locale left out keeps what "
            "it had; an explicit null removes the key from that locale only."
        ),
    )


class MutateRequest(BaseModel):
    locales_dir: str
    namespace: str = ""
    operations: list[OperationModel] = Field(default_factory=list)
    fingerprints: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Per-locale fingerprints from the load. A file that no longer "
            "matches makes the whole batch fail rather than overwrite it."
        ),
    )


@router.post("/namespaces")
def namespaces(req: NamespacesRequest):
    """Every namespace under the directory, with per-locale completeness."""
    refusal = _refused_in_server_mode()
    if refusal:
        return refusal
    try:
        path = _validate_dir(req.locales_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "namespaces")}
    try:
        discovery, summaries = list_namespaces(path)
    except EditorError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("namespaces failed")
        return {"success": False, "error": safe_error(e, logger, "namespaces")}

    if not discovery.locales:
        return {
            "success": False,
            "error": (
                f"No translation files found under {path}. Expected either "
                f"{path.name}/<lang>/*.json or {path.name}/<lang>.json."
            ),
        }
    return {
        "success": True,
        "locales_dir": str(discovery.root),
        "locales": sorted(discovery.locales),
        "layout": discovery.layout,
        "redirected_from": (
            str(discovery.redirected_from)
            if discovery.redirected_from is not None
            else None
        ),
        "namespaces": [s.to_dict() for s in summaries],
    }


@router.post("/namespace")
def namespace(req: NamespaceRequest):
    """One namespace across every locale, with the fingerprints a save needs."""
    refusal = _refused_in_server_mode()
    if refusal:
        return refusal
    try:
        path = _validate_dir(req.locales_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "namespace")}
    try:
        view = load_namespace(
            path, req.namespace, reference_locale=req.reference_locale
        )
    except EditorError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("namespace failed")
        return {"success": False, "error": safe_error(e, logger, "namespace")}
    return {"success": True, "view": view.to_dict()}


@router.post("/mutate")
def mutate(req: MutateRequest):
    """Apply a batch of edits to the translation files, or none of them."""
    refusal = _refused_in_server_mode()
    if refusal:
        return refusal
    try:
        path = _validate_dir(req.locales_dir)
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "mutate")}

    operations = [
        Operation(op=o.op, key=o.key, new_key=o.new_key, values=o.values)
        for o in req.operations
    ]
    unknown = {o.op for o in operations} - {"set", "add", "rename", "delete"}
    if unknown:
        return {
            "success": False,
            "error": f"Unknown operation(s): {', '.join(sorted(unknown))}.",
        }

    try:
        result = apply_operations(
            path, req.namespace, operations, expected_fingerprints=req.fingerprints
        )
    except StaleFileError as e:
        # Its own flag: the UI reloads and replays rather than showing an error
        # the user can only answer by losing their edits.
        return {"success": False, "error": str(e), "stale": True}
    except EditorError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("mutate failed")
        return {"success": False, "error": safe_error(e, logger, "mutate")}
    return {"success": True, **result.to_dict()}


class DetectRequest(BaseModel):
    project_dir: str = Field(..., description="Root of the project to look in.")


@router.post("/detect")
def detect(req: DetectRequest):
    """The translation directories this project actually has, best first."""
    refusal = _refused_in_server_mode()
    if refusal:
        return refusal
    try:
        path = validated_dir(req.project_dir, "project_dir")
    except ValueError as e:
        return {"success": False, "error": safe_error(e, logger, "detect")}
    try:
        roots = find_locale_roots(path)
    except EditorError as e:
        return {"success": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        logger.exception("detect failed")
        return {"success": False, "error": safe_error(e, logger, "detect")}
    return {"success": True, "roots": [r.to_dict() for r in roots]}
