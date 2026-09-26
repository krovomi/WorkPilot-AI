"""The hermes learning loop, as the Kanban sees it.

Three questions the task panel asks, and the answers a person gives back:

    GET  /api/hermes/status        can the loop run here, and what is pending
    POST /api/hermes/cycle         run one turn now, from a named surface
    POST /api/hermes/review        keep or turn down candidates from the queue
    POST /api/hermes/soul/install  install this repository's persona

`status` lists each pending candidate with what deciding needs — its purpose,
its hermes category, the first lines of the procedure — because a list of file
names is information nobody can act on. `review` is the action: keeping adopts
the skill into ``skills/hermes-learned/`` and files it in the shared brain
(`hermes.brain_link`); turning it down records the refusal in the adoption
ledger so it is never proposed again.

What `status` reports as pending is what a person still has to read, which is
not the same as what is on disk: `learning_loop.hermes_triage` has standing
answers about hermes's catalogue, and a queue filled before those existed holds
files this repository has already decided against. Those are counted, not
listed, and the next cycle withdraws them. Sixty rows nobody should read is how
a review queue turns into a pile.

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
from pydantic import BaseModel, Field

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


class ReviewRequest(BaseModel):
    files: list[str] = Field(default_factory=list, max_length=200)
    """Queue file names (``hermes--<slug>.md``), as `status` listed them."""
    decision: str
    """``adopt`` or ``decline``."""
    projectDir: str | None = None
    specId: str | None = None
    """The task the person was looking at: a kept skill's brain note links to it."""


def _pending(repo_root: Path) -> tuple[list[str], int]:
    """Candidates from hermes waiting in the review queue, and the stale ones.

    Delegated to `learning_loop.hermes_ingest.queue_state`, which is also what
    `runners/hermes_runner.py` calls: the queue is one directory, and two
    readings of it would disagree the moment one of them learned about triage
    and the other did not.
    """
    from learning_loop.hermes_ingest import queue_state

    return queue_state(repo_root)


def _status_payload(repo_root: Path) -> dict:
    from learning_loop.hermes_adopt import (
        ADOPTED_PACK,
        adopted_names,
        adoption_enabled,
        declined_names,
    )
    from learning_loop.hermes_review import candidate_details

    from .brain_link import brain_link

    report = doctor(repo_root)
    pending, stale = _pending(repo_root)
    return {
        "readiness": report.to_dict(),
        "soul": soul_status(repo_root).to_dict(),
        "pending": pending,
        "candidates": candidate_details(repo_root) if report.installed else [],
        "stale": stale,
        "adopted": adopted_names(repo_root),
        "adoptedPack": ADOPTED_PACK,
        "declined": len(declined_names(repo_root)),
        "autoAdopt": adoption_enabled(),
        "brain": brain_link().to_dict(),
        "surfaces": [
            {"id": key, "description": text} for key, text in SURFACES.items()
        ],
    }


@router.get("/status")
def hermes_status():
    """Readiness, persona and pending candidates. Read-only, no model, no network."""
    if _is_server_mode():
        return _DESKTOP_ONLY
    try:
        return {"success": True, "status": _status_payload(_REPO_ROOT)}
    except Exception:  # noqa: BLE001
        logger.exception("hermes status failed")
        return {"success": False, "error": "An internal error has occurred."}


def _task_ref(project_dir: str | None, spec_id: str | None) -> str | None:
    """``<project>/<spec>`` for the brain, or None. Names only, nothing is read."""
    if not project_dir or not spec_id:
        return None
    try:
        from brain.tasks import project_name

        return f"{project_name(Path(project_dir))}/{Path(spec_id).name}"
    except Exception:  # noqa: BLE001 - a missing link is not a failed decision
        return None


@router.post("/review")
def hermes_review(body: ReviewRequest):
    """A person keeps or turns down candidates. Returns the refreshed status.

    Each file is decided on its own and the ones that could not be are listed
    with a reason, so one bad name never loses the other thirty decisions.
    """
    if _is_server_mode():
        return _DESKTOP_ONLY
    try:
        from learning_loop.hermes_review import DECISIONS, decide

        if body.decision not in DECISIONS:
            return {"success": False, "error": "decision is 'adopt' or 'decline'"}
        outcome = decide(
            _REPO_ROOT,
            body.files,
            body.decision,
            surface="kanban",
            task=_task_ref(body.projectDir, body.specId),
        )
        return {
            "success": True,
            "review": outcome.to_dict(),
            "status": _status_payload(_REPO_ROOT),
        }
    except Exception:  # noqa: BLE001
        logger.exception("hermes review failed")
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
        status = _status_payload(_REPO_ROOT)
        payload["pending"] = status["pending"]
        payload["stale"] = status["stale"]
        return {"success": True, "cycle": payload, "status": status}
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
