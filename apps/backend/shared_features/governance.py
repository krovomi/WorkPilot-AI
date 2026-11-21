"""A server project's agent governance: its policy, its audit trail, its kill switch (#353, lot 4).

On a server, a project's agents run in its clone: they write the policy's audit
trail (``.workpilot/policy-audit.jsonl``) and the guardrails' requests for
approval there, and the desktop app's panel and kill switch, which read and
stop what runs on the computer, reached neither. These routes give them to the
project's team, the desktop app and the phone alike, by ``project_id`` only.

- **Reading** (``audit.read``, any role on the project): what
  ``workpilot.policy.yaml`` of the clone says, whether the agents may work now,
  the tokens of the last hour, the last fifty decisions and the two counts,
  the requests waiting for an approval, and how many agents run. Paths of the
  server never leave it: each one is written relative to the clone.
- **Exporting** (``audit.export``): the whole trail, newest first, which the
  app turns into a CSV or JSON file as it does for a project of the computer.
- **Approving** a ``requires_review`` call (``review.approve``, role ``member``
  or more): the person is the server's account, so the answer names them, the
  roles they hold and their id, and the trail's ``approved`` line says who.
  When the policy names ``files.reviewers``, the person must hold one of those
  roles; the desktop app alone has no verified identity, so it cannot apply
  that list and says so.
- **Stopping** (``agent.cancel``, role ``member`` or more): every run and job of
  the project that the caller started (``scope: "mine"``, what the desktop
  app's kill switch sends for each server project), or every one of the
  project, whoever started it (``scope: "project"``), which is the project
  owner's or an organization administrator's. Stopping is the same as Stop on
  a card: the run ends cancelled and its plan keeps what it finished.

Each answer and each stop is written to the server's audit log.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi import Path as RoutePath
from pydantic import BaseModel, ConfigDict
from server.authz.approvals import role_slugs
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import AuditLog, ProjectRole
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/governance", tags=["features"])

_WRITER_ROLES = {ProjectRole.MEMBER.value, ProjectRole.OWNER.value}
_REQUEST_ID = r"^[0-9a-f]{12}$"
#: What one export answers at most: the trail keeps no more.
MAX_EXPORTED = 10_000
_TEXT_CHARS = 1_000


class AnswerRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    approved: bool


class StopRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scope: Literal["mine", "project"] = "mine"


def _is_manager(scope: ProjectScope, principal: Principal) -> bool:
    """The project's owner, or an organization administrator who reaches it
    without a membership row."""
    if scope.project_role is None:
        return principal.is_platform_admin or principal.has("project.member.write")
    return scope.project_role == ProjectRole.OWNER.value


def _is_writer(scope: ProjectScope, principal: Principal) -> bool:
    return scope.project_role in _WRITER_ROLES or _is_manager(scope, principal)


def _require_writer(scope: ProjectScope, principal: Principal) -> None:
    if not _is_writer(scope, principal):
        raise HTTPException(status_code=403, detail="Requires project role 'member'")


def _relative(value: Any, clone: Path) -> Any:
    """``value`` with every path of the clone written relative to it, and the
    server's home folder as ``~``: a client never learns where things live."""
    if isinstance(value, str):
        text = value
        for root in {str(clone.resolve()), str(clone)}:
            text = text.replace(root + "/", "").replace(root + "\\", "")
            text = text.replace(root, ".")
        home = str(Path.home())
        if len(home) > 1:
            text = text.replace(home, "~")
        return text[:_TEXT_CHARS]
    if isinstance(value, list):
        return [_relative(item, clone) for item in value]
    if isinstance(value, dict):
        return {key: _relative(item, clone) for key, item in value.items()}
    return value


def _request_public(event: dict[str, Any]) -> dict[str, Any]:
    target = event.get("target") if isinstance(event.get("target"), dict) else {}
    return {
        "id": event.get("id"),
        "at": event.get("at"),
        "rules": [str(r) for r in event.get("rules", [])][:20],
        "tool": event.get("tool"),
        "target": {"kind": target.get("kind"), "summary": target.get("summary")},
        "task": event.get("task"),
        "message": event.get("message"),
    }


def _report(clone: Path) -> dict[str, Any]:
    """What the governance panel shows, read from the clone (in a thread)."""
    from runners.guardrails_runner import governance_report
    from security import guardrail_ledger as ledger

    report = governance_report(clone)
    report["pending"] = [_request_public(e) for e in ledger.pending(clone)]
    return _relative(report, clone)


def _reviewers(clone: Path) -> list[str]:
    from security.guardrail_policy import load_policy

    governance = load_policy(clone).governance
    return list(governance.reviewers) if governance else []


@router.get("")
async def governance(
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
) -> dict[str, Any]:
    """The project's policy, its last decisions, its requests and its agents."""
    from server.services.project_jobs import get_project_jobs
    from server.services.run_manager import get_run_manager

    report = await asyncio.to_thread(_report, scope.path)
    runs, jobs = get_run_manager(), get_project_jobs()
    writer = _is_writer(scope, principal)
    report["agents"] = {
        "mine": len(runs.active_runs(scope.project_id, principal.id))
        + len(jobs.active_jobs(scope.project_id, principal.id)),
        "project": len(runs.active_runs(scope.project_id))
        + len(jobs.active_jobs(scope.project_id)),
    }
    report["may"] = {
        "approve": writer and principal.has("review.approve"),
        "stop": writer and principal.has("agent.cancel"),
        "stopProject": _is_manager(scope, principal) and principal.has("agent.cancel"),
        "export": principal.has("audit.export"),
    }
    return report


@router.get("/audit")
async def audit(
    limit: int = Query(MAX_EXPORTED, ge=1, le=MAX_EXPORTED),
    scope: ProjectScope = Depends(resolve_project_scope),
) -> dict[str, Any]:
    """The project's audit trail, newest first, for an export."""
    from security.policy_audit import read_events

    events = await asyncio.to_thread(read_events, scope.path, limit)
    return {"events": _relative(events, scope.path)}


@router.post("/approvals/{request_id}")
async def answer(
    req: AnswerRequest,
    request_id: str = RoutePath(pattern=_REQUEST_ID),
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Approve or refuse one call an agent is waiting on, as this person."""
    from security import guardrail_ledger as ledger

    _require_writer(scope, principal)
    request = await asyncio.to_thread(ledger.find_pending, scope.path, request_id)
    if request is None:
        raise HTTPException(status_code=404, detail="request_not_found")
    held = await role_slugs(
        db, user_id=principal.id, org_id=scope.org_id, project_id=scope.project_id
    )
    wanted = await asyncio.to_thread(_reviewers, scope.path)
    if req.approved and wanted and not set(wanted) & set(held):
        raise HTTPException(
            status_code=403,
            detail="workpilot.policy.yaml asks one of these roles to approve: "
            + ", ".join(wanted),
        )
    name = (principal.display_name or principal.email or principal.id)[:120]
    entry = await asyncio.to_thread(
        ledger.answer,
        scope.path,
        request_id,
        req.approved,
        name,
        by_id=principal.id,
        roles=held,
    )
    if entry is None:  # answered by someone else in between
        raise HTTPException(status_code=404, detail="request_not_found")
    db.add(
        AuditLog(
            user_id=principal.id,
            org_id=scope.org_id,
            project_id=scope.project_id,
            action="governance.approval.answered",
            payload={
                "request": request_id,
                "decision": entry["decision"],
                "rules": entry["rules"],
                "roles": held,
            },
        )
    )
    await db.commit()
    return {
        "answer": {
            "request": request_id,
            "decision": entry["decision"],
            "by": name,
            "roles": held,
            "expiresAt": entry["expires_at"],
        }
    }


@router.post("/stop")
async def stop(
    req: StopRequest,
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The kill switch of a server project: stop its runs and jobs now."""
    from server.services.project_jobs import get_project_jobs
    from server.services.run_manager import get_run_manager

    _require_writer(scope, principal)
    if req.scope == "project" and not _is_manager(scope, principal):
        raise HTTPException(
            status_code=403,
            detail="Stopping every agent of the project is its owner's",
        )
    starter = principal.id if req.scope == "mine" else None
    runs = await get_run_manager().stop_runs(scope.project_id, starter)
    jobs = await get_project_jobs().stop_jobs(scope.project_id, starter)
    db.add(
        AuditLog(
            user_id=principal.id,
            org_id=scope.org_id,
            project_id=scope.project_id,
            action="governance.stop_all",
            payload={"scope": req.scope, "runs": len(runs), "jobs": len(jobs)},
        )
    )
    await db.commit()
    return {"scope": req.scope, "stoppedRuns": len(runs), "stoppedJobs": len(jobs)}
