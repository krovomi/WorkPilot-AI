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

from core.api_safety import server_mode_roots
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
        # The project's file first, the process environment over it — the
        # same precedence `settings.apply_project_env` gives a build, so the
        # panel reports what a build on this project would actually do rather
        # than a third opinion.
        env: dict[str, str] = {}
        if project_dir:
            env = project_env(Path(project_dir))
        report = doctor({**env, **os.environ})
        savings = read_savings(project_dir) if project_dir else read_savings()
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
