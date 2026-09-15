"""Watermark stripping, as the desktop app sees it.

    GET /api/watermarks/status?project_dir=…&spec_dir=…

One endpoint, read-only, and no action. There is deliberately nothing here that
turns the feature on or off: the switches live in `.workpilot/.env`, which the
settings screen already writes, and a second writer of the same key is a second
answer to "what is this project configured to do".

Refused in server mode, like `workflows/api.py`, `hermes/api.py` and
`rtk/api.py`, and for the same reason: the answer is about a vendored tree on
the machine running the backend and a ledger in a directory the caller names.
On a shared deployment that machine is the server, and a client naming a
directory on it is a cross-tenant read.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from core.api_safety import safe_error, server_mode_roots, validated_dir
from fastapi import APIRouter

from . import settings
from .ledger import read_entries
from .runtime import check

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/watermarks", tags=["watermarks"])

_DESKTOP_ONLY = {
    "success": False,
    "error": "watermark status is a desktop feature",
    "reason": "server-mode",
}


def _summarise(entries: list[dict]) -> dict[str, object]:
    """What the ledger adds up to: files touched, codepoints removed, by name."""
    by_codepoint: dict[str, int] = {}
    files: set[str] = set()
    removed = 0
    replaced = 0
    for entry in entries:
        path = entry.get("file")
        if isinstance(path, str) and path:
            files.add(path)
        for bucket in ("removed", "replaced"):
            counts = entry.get(bucket)
            if not isinstance(counts, dict):
                continue
            for label, count in counts.items():
                if isinstance(count, int):
                    by_codepoint[str(label)] = by_codepoint.get(str(label), 0) + count
        for key, add in (("removed_count", "removed"), ("replaced_count", "replaced")):
            value = entry.get(key)
            if isinstance(value, int):
                if add == "removed":
                    removed += value
                else:
                    replaced += value
    return {
        "entries": len(entries),
        "files": len(files),
        "removed_count": removed,
        "replaced_count": replaced,
        # Most-frequent first: the point of the list is "what is this model
        # putting in my files", and that question is answered by the top rows.
        "by_codepoint": dict(
            sorted(by_codepoint.items(), key=lambda kv: (-kv[1], kv[0]))[:20]
        ),
    }


@router.get("/status")
def watermarks_status(project_dir: str | None = None, spec_dir: str | None = None):
    """Readiness, the settings in force, and what has actually been stripped."""
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    try:
        # A path from a client is never opened as it arrives. `validated_dir` is
        # the house answer: it refuses `..`, refuses what is outside the allowed
        # roots, and requires the directory to exist. The endpoint is already
        # desktop-only, but "the caller cannot reach this endpoint" and "this
        # endpoint cannot be pointed at an arbitrary path" are two different
        # guarantees, and only the second one survives a refactor.
        resolved_project: Path | None = None
        resolved_spec: Path | None = None
        for raw, label in ((project_dir, "project_dir"), (spec_dir, "spec_dir")):
            if not raw:
                continue
            try:
                validated = validated_dir(raw, label)
            except ValueError as exc:
                return {
                    "success": False,
                    "error": safe_error(exc, logger, "watermarks_status"),
                }
            if label == "project_dir":
                resolved_project = validated
            else:
                resolved_spec = validated

        # The project's file first, the process environment over it — the same
        # precedence `settings.apply_project_env` gives a build, so the panel
        # reports what a build on this project would actually do rather than a
        # third opinion.
        env = settings.project_env(resolved_project) if resolved_project else {}
        merged = {**env, **os.environ}
        return {
            "success": True,
            "status": {
                "readiness": check().to_dict(),
                "settings": {
                    "enabled": settings.is_enabled(merged),
                    "normalize_spaces": settings.normalize_spaces(merged),
                    "strip_bidi": settings.strip_bidi(merged),
                    "max_bytes": settings.max_bytes(merged),
                },
                "ledger": _summarise(read_entries(resolved_spec)),
            },
        }
    except Exception:  # noqa: BLE001
        logger.exception("watermarks status failed")
        return {"success": False, "error": "An internal error has occurred."}
