"""A person's own usage: ``/users/me/usage*`` (any signed-in account).

- ``GET /users/me/usage``: exactly what the organization's administrators
  see of the caller in the Usage tab (the person sheet), with who they are;
- ``GET /users/me/usage/export``: every usage row about the caller, in every
  organization, as one JSON file (right of access and portability);
- ``GET``/``POST /users/me/usage-notice``: the notice that says what is
  measured; reading it is recorded in the audit log (``usage.notice.seen``).
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from server.auth.deps import CurrentUser, get_current_user
from server.authz.deps import require_org
from server.db.engine import get_db
from server.db.models import User
from server.routers.usage_admin import period
from server.services import usage_report, usage_self
from server.services.audit import record
from server.services.usage_report import Scope
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users/me", tags=["usage"])


async def _account(db: AsyncSession, user: CurrentUser) -> User:
    account = await db.get(User, user.id)
    if account is None:
        raise HTTPException(status_code=404, detail="Account not found")
    return account


@router.get("/usage")
async def my_usage(
    asked: Scope = Depends(period),
    org_id: str = Depends(require_org),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    account = await _account(db, user)
    mine = Scope(org_id, asked.start, asked.end, user_id=user.id)
    return {
        "user": {
            "user_id": account.id,
            "name": account.display_name,
            "email": account.email,
        },
        "visible_to": await usage_self.visible_to(db, org_id),
        "summary": await usage_report.summary(db, mine),
        "daily": await usage_report.daily(db, mine),
        "timeline": await usage_report.timeline(db, mine),
        "pages": await usage_report.pages(db, mine),
    }


@router.get("/usage/export")
async def export_my_usage(
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    data = await usage_self.export_of(db, await _account(db, user))
    day = datetime.now(UTC).date().isoformat()
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=2),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="workpilot-my-usage-{day}.json"'
        },
    )


@router.get("/usage-notice")
async def usage_notice(
    org_id: str = Depends(require_org),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    return await usage_self.notice_due(db, user.id, org_id)


@router.post("/usage-notice")
async def usage_notice_seen(
    request: Request,
    org_id: str = Depends(require_org),
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    notice = await usage_self.notice_due(db, user.id, org_id)
    if notice["due"]:
        await record(
            db,
            action=usage_self.NOTICE_SEEN,
            actor_id=user.id,
            org_id=org_id,
            payload={"page_activity": notice["page_activity"]},
            request=request,
        )
        await db.commit()
    return {**notice, "due": False}
