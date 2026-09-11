"""The hermes learning loop, as the Kanban sees it.

Three questions the task panel asks, and one action it may take:

    GET  /api/hermes/status        can the loop run here, and what is pending
    POST /api/hermes/cycle         run one turn now, from a named surface
    POST /api/hermes/soul/install  install this repository's persona

Why the trust gate has no button
--------------------------------
`status` reports whether this checkout is listed in hermes's
``skills.trusted_project_dirs``, and returns the exact command that fixes it —
but there is no endpoint that runs it. Trusting a checkout makes every SKILL.md
in it a procedure hermes will follow in every session on the machine, which is
the prompt-injection vector the gate was built to close. Software that grants
itself the trust is software that has removed the gate. It is a per-machine
decision by a person, and the most this panel does is tell them what to type.

Refused in server mode
----------------------
Like `workflows/api.py`, and for a sharper reason: every answer here is about
``$HERMES_HOME`` and about this checkout's own ``skills/_proposed/``. On a
shared deployment that home belongs to the server process, not to the tenant
asking, so a tenant reading it would be reading someone else's agent identity
and writing into a review queue that is not theirs. There is no per-tenant
hermes to address, so the honest answer is "not here" rather than a scoped
half-answer.
"""

from __future__ import annotations

import logging
from pathlib import Path

from core.api_safety import server_mode_roots
from fastapi import APIRouter
from pydantic import BaseModel

from .loop import SURFACES, run_cycle
from .readiness import doctor
from .soul import install_soul, soul_status

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/hermes", tags=["hermes"])

_REPO_ROOT = Path(__file__).resolve().parents[3]

_DESKTOP_ONLY = {
    "success": False,
    "error": "the hermes learning loop is a desktop feature",
    "reason": "server-mode",
}


def _is_server_mode() -> bool:
    return server_mode_roots() is not None


class CycleRequest(BaseModel):
    surface: str = "kanban"
    """Which feature is asking. Unknown names fall back rather than fail."""
    dryRun: bool = False


class SoulRequest(BaseModel):
    overwrite: bool = False


def _pending(repo_root: Path) -> list[str]:
    """Candidates from hermes already waiting in the review queue.

    Names only. The queue is a directory in this repository and the caller is
    looking at the same checkout, so a file name is what opens it and a full
    path is a detail an error message has no business carrying.
    """
    try:
        from learning_loop.skill_proposer import proposal_dir

        return sorted(p.name for p in proposal_dir(repo_root).glob("hermes--*.md"))
    except Exception as exc:  # noqa: BLE001 - an unreadable queue is not an outage
        logger.debug("could not read the proposal queue: %s", exc)
        return []


@router.get("/status")
def hermes_status():
    """Readiness, persona and pending candidates. Read-only, no model, no network."""
    if _is_server_mode():
        return _DESKTOP_ONLY
    try:
        report = doctor(_REPO_ROOT)
        return {
            "success": True,
            "status": {
                "readiness": report.to_dict(),
                "soul": soul_status(_REPO_ROOT).to_dict(),
                "pending": _pending(_REPO_ROOT),
                "surfaces": [
                    {"id": key, "description": text} for key, text in SURFACES.items()
                ],
            },
        }
    except Exception:  # noqa: BLE001
        logger.exception("hermes status failed")
        return {"success": False, "error": "An internal error has occurred."}


@router.post("/cycle")
def hermes_cycle(body: CycleRequest):
    """One turn of the loop, opened by a person rather than by a build.

    The result is candidates in ``skills/_proposed/`` and nothing else. Nothing
    is promoted, nothing under ``skills/<pack>/`` is touched, and nothing under
    the hermes home is written.
    """
    if _is_server_mode():
        return _DESKTOP_ONLY
    try:
        result = run_cycle(_REPO_ROOT, surface=body.surface, write=not body.dryRun)
        payload = result.to_dict()
        payload["pending"] = _pending(_REPO_ROOT)
        return {"success": True, "cycle": payload}
    except Exception:  # noqa: BLE001
        logger.exception("hermes cycle failed")
        return {"success": False, "error": "An internal error has occurred."}


@router.post("/soul/install")
def hermes_install_soul(body: SoulRequest):
    """Copy this repository's `SOUL.md` into the hermes home.

    The one write this router makes outside the repository, and it is the
    user's own agent identity — so it happens only from a button they pressed,
    it refuses to replace a different persona unless they said so, and the one
    it replaces is kept beside it with a timestamp.
    """
    if _is_server_mode():
        return _DESKTOP_ONLY
    try:
        changed, message = install_soul(_REPO_ROOT, overwrite=body.overwrite)
        return {
            "success": True,
            "changed": changed,
            "message": message,
            "soul": soul_status(_REPO_ROOT).to_dict(),
        }
    except Exception:  # noqa: BLE001
        logger.exception("SOUL.md install failed")
        return {"success": False, "error": "An internal error has occurred."}
