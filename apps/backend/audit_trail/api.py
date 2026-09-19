"""HTTP routes for the AuditTrail.

Mounted at `/api/audit-trail`. Endpoints:

* `POST /append`              — append one event
* `POST /append-decision`     — convenience for DECISION_MADE events
* `GET  /events`              — filter events (actor / kind / since / until)
* `GET  /replay/{cid}`        — replay all events for a correlation_id
* `GET  /verify`              — confirm chain integrity
* `GET  /trails`              — list trails on disk
* `GET  /export/soc2`         — flat CSV log for SOC2 audits
* `GET  /export/gdpr`         — JSON DSAR bundle for GDPR data subject requests
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from threading import Lock
from typing import Any

from core.api_safety import safe_error, server_mode_roots, validated_dir
from fastapi import APIRouter, Query
from fastapi import Path as PathParam
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from .exports import build_dsar_bundle, render_soc2_csv
from .trail import AuditEventKind, AuditTrail, Decision

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/audit-trail", tags=["audit-trail"])

# One trail instance per (storage_dir, name) so concurrent appends
# don't cross streams.
_trails: dict[tuple[str, str], AuditTrail] = {}
_trails_lock = Lock()


def _allowed_storage_roots() -> list[Path] | None:
    """Roots under which audit-trail storage_dir is allowed to live.

    Every endpoint here accepts ``storage_dir`` from the request and creates
    the directory if missing, so where that path may point is a real
    question. It has three answers, and only the middle one is a guess:

    * ``AUDIT_TRAIL_ALLOWED_ROOTS`` (os-pathsep separated) when set — an
      explicit deployment decision, and it wins in either mode.
    * **server mode**: `server_mode_roots`, the ``REPOS_ROOT`` subtree every
      project is cloned under. Tighter than what this used to do, and the
      answer the rest of the backend already gives.
    * **local mode**: unconfined, like every other path-taking endpoint in
      this backend. `core.api_safety` states the reason for all of them:
      there is no privilege boundary to draw, because the backend runs as
      the person who chose the directory in their own desktop app.

    The fallback this replaces was the current working directory. That reads
    as caution and was not: the backend is spawned with ``cwd=apps/backend``,
    while `agents.agent_audit` writes every trail to
    ``<project_dir>/.workpilot/audit-trail`` — inside the user's own
    checkout, outside this repository by definition. So the one panel built
    to read those trails could reach no directory any of them is ever
    written to, and said "Invalid input" about the path the app itself had
    chosen. A guard that admits only a directory nothing writes to is not
    protecting anything; it is switching the feature off.
    """
    raw = os.environ.get("AUDIT_TRAIL_ALLOWED_ROOTS", "").strip()
    if raw:
        return [
            Path(p).expanduser().resolve() for p in raw.split(os.pathsep) if p.strip()
        ]
    return server_mode_roots()


# What a caller is told when `storage_dir` sits outside every allowed root.
#
# A module constant rather than the exception's own message, and that is the
# whole point: `safe_error` is a barrier because it returns fixed strings, and
# an earlier version of `_error` returned `str(e)` for this one case. CodeQL
# read that correctly — exception data reaching a response — and raised
# `py/stack-trace-exposure` at all seventeen handlers below. Returning a
# constant says the same sentence to the user with nothing derived from the
# exception in it, so there is no flow left to trace.
#
# The roots themselves are not named. They are server configuration, and in
# server mode this router is mounted for tenants who have no business reading
# the deployment's layout.
STORAGE_DIR_REFUSED = (
    "This directory is outside the roots the audit trail may read. "
    "Set AUDIT_TRAIL_ALLOWED_ROOTS on the backend to include it."
)


class StorageDirRefused(ValueError):
    """`storage_dir` sits outside every allowed root.

    A distinct type because this one refusal is worth reporting in full, and
    `safe_error` — rightly — flattens every `ValueError` here to "Invalid
    input". That answer is unreadable for the only mistake a user can actually
    make on this endpoint: naming a directory the backend is not configured to
    reach. `api_safety`'s own guidance is to raise a literal message where the
    handler knows something more useful, and this handler does.

    The type is what carries the meaning; the caller reads
    `STORAGE_DIR_REFUSED`, never this exception's message.
    """


def _validate_dir(raw: str) -> Path:
    """Normalise `storage_dir`, and confine it where a root exists to confine it to.

    `validated_dir` adds the normalisation and the `..` refusal that CodeQL
    recognises as a barrier; `is_relative_to`, which the allowlist uses, it
    does not recognise at all, so the module reported `py/path-injection`
    despite being correctly confined. `must_exist=False` because the
    directory is created below rather than required up front. A ``None`` from
    `_allowed_storage_roots` is local mode, where `validated_dir` normalises
    without confining — see its module docstring for why that is the right
    answer there and not a gap.
    """
    roots = _allowed_storage_roots()
    try:
        p = validated_dir(raw, "storage_dir", allowed_roots=roots, must_exist=False)
    except ValueError as e:
        if "outside every allowed root" in str(e):
            raise StorageDirRefused(STORAGE_DIR_REFUSED) from e
        raise
    p.mkdir(parents=True, exist_ok=True)
    return p


def _error(e: Exception, op: str) -> str:
    """The message a caller gets. One refusal speaks for itself; the rest don't.

    Every handler below funnels through here instead of calling `safe_error`
    directly, so the one refusal a caller can act on reaches them while
    everything else still collapses to "Invalid input" with the real cause in
    the log. Both arms return a fixed string: nothing derived from the
    exception is ever handed back.
    """
    if isinstance(e, StorageDirRefused):
        logger.warning("%s refused a storage_dir outside the allowed roots", op)
        return STORAGE_DIR_REFUSED
    return safe_error(e, logger, op)


def _get_trail(storage_dir: str, name: str) -> AuditTrail:
    path = _validate_dir(storage_dir)
    key = (str(path), name)
    with _trails_lock:
        trail = _trails.get(key)
        if trail is None:
            trail = AuditTrail(storage_dir=path, name=name)
            _trails[key] = trail
        return trail


class AppendRequest(BaseModel):
    storage_dir: str
    trail_name: str = Field("default", min_length=1, max_length=128)
    kind: str = Field(..., min_length=1)
    actor: str = Field(..., min_length=1)
    correlation_id: str = Field(..., min_length=1)
    summary: str = ""
    payload: dict[str, Any] | None = None


class AppendDecisionRequest(BaseModel):
    storage_dir: str
    trail_name: str = Field("default", min_length=1, max_length=128)
    actor: str = Field(..., min_length=1)
    correlation_id: str = Field(..., min_length=1)
    decision_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1)
    chosen_option: str = Field(..., min_length=1)
    rejected_options: list[str] | None = None
    rationale: str = ""
    risk_score: float = 0.0


@router.post("/append")
def append(req: AppendRequest):
    try:
        trail = _get_trail(req.storage_dir, req.trail_name)
        evt = trail.append(
            kind=req.kind,
            actor=req.actor,
            correlation_id=req.correlation_id,
            summary=req.summary,
            payload=req.payload,
        )
        return {"success": True, "event": evt.to_dict()}
    except ValueError as e:
        return {"success": False, "error": _error(e, "append")}
    except Exception as e:  # noqa: BLE001
        logger.exception("append failed")
        return {"success": False, "error": _error(e, "append")}


@router.post("/append-decision")
def append_decision(req: AppendDecisionRequest):
    try:
        trail = _get_trail(req.storage_dir, req.trail_name)
        decision = Decision(
            decision_id=req.decision_id,
            title=req.title,
            chosen_option=req.chosen_option,
            rejected_options=tuple(req.rejected_options or ()),
            rationale=req.rationale,
            risk_score=req.risk_score,
        )
        evt = trail.append_decision(
            actor=req.actor,
            correlation_id=req.correlation_id,
            decision=decision,
        )
        return {"success": True, "event": evt.to_dict()}
    except ValueError as e:
        return {"success": False, "error": _error(e, "append_decision")}
    except Exception as e:  # noqa: BLE001
        logger.exception("append_decision failed")
        return {"success": False, "error": _error(e, "append_decision")}


@router.get("/events")
def events(
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
    actor: str | None = Query(None),
    kind: str | None = Query(None),
    since: float | None = Query(None),
    until: float | None = Query(None),
):
    try:
        trail = _get_trail(storage_dir, trail_name)
        # Validate the kind early to give a clean 400 instead of leaking
        # the underlying ValueError later.
        if kind is not None:
            try:
                AuditEventKind(kind)
            except ValueError as e:
                return {"success": False, "error": _error(e, "events")}
        results = trail.filter(actor=actor, kind=kind, since=since, until=until)
        return {
            "success": True,
            "events": [e.to_dict() for e in results],
            "count": len(results),
        }
    except ValueError as e:
        return {"success": False, "error": _error(e, "events")}
    except Exception as e:  # noqa: BLE001
        logger.exception("events failed")
        return {"success": False, "error": _error(e, "events")}


@router.get("/replay/{correlation_id}")
def replay(
    correlation_id: str = PathParam(..., min_length=1, max_length=256),
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
):
    try:
        trail = _get_trail(storage_dir, trail_name)
        bundle = trail.replay(correlation_id)
        return {"success": True, "bundle": bundle.to_dict()}
    except ValueError as e:
        return {"success": False, "error": _error(e, "replay")}
    except Exception as e:  # noqa: BLE001
        logger.exception("replay failed")
        return {"success": False, "error": _error(e, "replay")}


@router.get("/verify")
def verify(storage_dir: str = Query(...), trail_name: str = Query("default")):
    try:
        trail = _get_trail(storage_dir, trail_name)
        report = trail.verify()
        return {"success": True, "integrity": report.to_dict()}
    except ValueError as e:
        return {"success": False, "error": _error(e, "verify")}
    except Exception as e:  # noqa: BLE001
        logger.exception("verify failed")
        return {"success": False, "error": _error(e, "verify")}


@router.get("/trails")
def list_trails(storage_dir: str = Query(...)):
    try:
        path = _validate_dir(storage_dir)
        return {"success": True, "trails": AuditTrail.list_trails(path)}
    except ValueError as e:
        return {"success": False, "error": _error(e, "list_trails")}
    except Exception as e:  # noqa: BLE001
        logger.exception("list_trails failed")
        return {"success": False, "error": _error(e, "list_trails")}


@router.get("/export/soc2")
def export_soc2(
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
    since: float | None = Query(None),
    until: float | None = Query(None),
):
    """Return the trail as a SOC2-formatted CSV (text/csv)."""
    try:
        trail = _get_trail(storage_dir, trail_name)
        events = trail.filter(since=since, until=until)
        csv_text = render_soc2_csv(events)
        return PlainTextResponse(
            content=csv_text,
            media_type="text/csv",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="audit_trail_{trail_name}_soc2.csv"'
                ),
            },
        )
    except ValueError as e:
        return {"success": False, "error": _error(e, "export_soc2")}
    except Exception as e:  # noqa: BLE001
        logger.exception("export_soc2 failed")
        return {"success": False, "error": _error(e, "export_soc2")}


@router.get("/export/gdpr")
def export_gdpr(
    storage_dir: str = Query(...),
    trail_name: str = Query("default"),
    actor: str | None = Query(None),
    correlation_id: str | None = Query(None),
):
    """Return a GDPR DSAR bundle (JSON) for the given data subject.

    Exactly one of ``actor`` / ``correlation_id`` must be supplied.
    """
    try:
        trail = _get_trail(storage_dir, trail_name)
        bundle = build_dsar_bundle(trail, actor=actor, correlation_id=correlation_id)
        return {"success": True, "bundle": bundle.to_dict()}
    except ValueError as e:
        return {"success": False, "error": _error(e, "export_gdpr")}
    except Exception as e:  # noqa: BLE001
        logger.exception("export_gdpr failed")
        return {"success": False, "error": _error(e, "export_gdpr")}
