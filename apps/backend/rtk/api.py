"""rtk, as the desktop app sees it.

    GET /api/rtk/status?project_dir=…   is it working here, and what has it saved

One endpoint, read-only, and no action. There is deliberately no button that
runs `rtk init -g`: that command writes a hook into the user's own Claude Code
settings, which governs every session they open on that machine and not only
the ones WorkPilot drives. The same reasoning as the hermes trust gate — the
panel reports the condition and prints the command; the person types it.

Refused in server mode, like `workflows/api.py` and `hermes/api.py`: every
answer here is about a binary on the machine running the backend and about a
ledger in its home directory. On a shared deployment that machine is the
server, so a tenant reading it would be reading the server's numbers, not
their own.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from core.api_safety import safe_error, server_mode_roots, validated_dir
from fastapi import APIRouter

from .runtime import doctor
from .settings import project_env
from .stats import read_savings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/rtk", tags=["rtk"])

_DESKTOP_ONLY = {
    "success": False,
    "error": "rtk status is a desktop feature",
    "reason": "server-mode",
}


@router.get("/status")
def rtk_status(project_dir: str | None = None):
    """Readiness, settings and savings. No model, no network, one exec."""
    if server_mode_roots() is not None:
        return _DESKTOP_ONLY
    try:
        # A path from a client is never opened as it arrives. `validated_dir`
        # is the house answer: it refuses `..`, refuses what is outside the
        # allowed roots, and requires the directory to exist. The endpoint is
        # already desktop-only, but "the caller cannot reach this endpoint" and
        # "this endpoint cannot be pointed at an arbitrary path" are two
        # different guarantees, and only the second one survives a refactor.
        resolved: Path | None = None
        if project_dir:
            try:
                resolved = validated_dir(project_dir, "project_dir")
            except ValueError as exc:
                return {
                    "success": False,
                    "error": safe_error(exc, logger, "rtk_status"),
                }

        # The project's file first, the process environment over it — the
        # same precedence `settings.apply_project_env` gives a build, so the
        # panel reports what a build on this project would actually do rather
        # than a third opinion.
        env = project_env(resolved) if resolved else {}
        report = doctor({**env, **os.environ})
        savings = read_savings(resolved) if resolved else read_savings()
        return {
            "success": True,
            "status": {
                "readiness": report.to_dict(),
                "savings": savings.to_dict(),
            },
        }
    except Exception:  # noqa: BLE001
        logger.exception("rtk status failed")
        return {"success": False, "error": "An internal error has occurred."}
