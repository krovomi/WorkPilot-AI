"""Page activity and what an organization collects about usage.

``/users/me/page-activity``: whether the person's apps send which pages they
open (``GET``), and the counts they send (``POST``). The routes name no user:
a person writes only their own counts, in the organization their token acts
in, so being signed in is the whole permission, as for
``/users/me/preferences``. A page outside the closed lists refuses the batch
with 422; while the organization has page activity off, nothing is kept.

``/admin/usage/settings``: the organization's usage settings (page activity on
or off, retention), read with ``usage.read`` and changed with ``usage.write``,
every change audited (``org.usage_settings.updated``). Turning page activity
off erases the organization's page counts at once.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field
from server.auth.deps import CurrentUser, get_current_user
from server.authz.deps import require_org, require_permission
from server.config import get_settings
from server.db.engine import get_db
from server.db.models import Organization
from server.services import page_activity, usage_settings
from server.services.audit import record
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["usage"])

SETTINGS_UPDATED = "org.usage_settings.updated"


class VisitIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    day: date = Field(strict=False)
    page: str = Field(min_length=1, max_length=60)
    count: int = Field(ge=1, le=page_activity.MAX_COUNT)


class VisitsIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    client: Literal["desktop", "mobile"]
    visits: list[VisitIn] = Field(max_length=page_activity.MAX_VISITS)


class PageActivityState(BaseModel):
    enabled: bool


class Recorded(BaseModel):
    enabled: bool
    recorded: int


@router.get("/users/me/page-activity", response_model=PageActivityState)
async def page_activity_state(
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PageActivityState:
    org_id = getattr(request.state, "org_id", None)
    settings = await usage_settings.of_org(db, org_id)
    return PageActivityState(enabled=settings.page_activity)


@router.post("/users/me/page-activity", response_model=Recorded)
async def send_page_activity(
    body: VisitsIn,
    request: Request,
    user: CurrentUser = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Recorded:
    visits = [page_activity.Visit(v.day, v.page, v.count) for v in body.visits]
    try:
        page_activity.check(body.client, visits)
    except page_activity.UnknownPage as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    org_id = getattr(request.state, "org_id", None)
    settings = await usage_settings.of_org(db, org_id)
    if org_id is None or not settings.page_activity:
        return Recorded(enabled=False, recorded=0)
    recorded = await page_activity.record(
        db,
        user_id=user.id,
        org_id=org_id,
        client=body.client,
        visits=visits,
        today=datetime.now(UTC).date(),
    )
    return Recorded(enabled=True, recorded=recorded)


class SettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    page_activity: bool
    usage_retention_days: int | None = Field(
        default=None, ge=usage_settings.MIN_DAYS, le=usage_settings.MAX_DAYS
    )
    page_activity_retention_days: int | None = Field(
        default=None, ge=usage_settings.MIN_DAYS, le=usage_settings.MAX_DAYS
    )


class ServerDefaults(BaseModel):
    usage_retention_days: int
    page_activity_retention_days: int


class SettingsOut(BaseModel):
    page_activity: bool
    page_activity_since: str | None
    usage_retention_days: int | None
    page_activity_retention_days: int | None
    #: What ``None`` keeps: the server's retention.
    defaults: ServerDefaults


def _out(settings: usage_settings.UsageSettings) -> SettingsOut:
    server = get_settings()
    return SettingsOut(
        **settings.as_dict(),
        defaults=ServerDefaults(
            usage_retention_days=usage_settings.bounded(server.usage_retention_days),
            page_activity_retention_days=usage_settings.bounded(
                server.page_activity_retention_days
            ),
        ),
    )


@router.get(
    "/admin/usage/settings",
    response_model=SettingsOut,
    dependencies=[Depends(require_permission("usage.read"))],
)
async def read_settings(
    org_id: str = Depends(require_org),
    db: AsyncSession = Depends(get_db),
) -> SettingsOut:
    return _out(await usage_settings.of_org(db, org_id))


@router.put("/admin/usage/settings", response_model=SettingsOut)
async def write_settings(
    body: SettingsIn,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("usage.write")),
    db: AsyncSession = Depends(get_db),
) -> SettingsOut:
    org = await db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    before = usage_settings.of(org.settings)
    turned_on = body.page_activity and not before.page_activity
    after = usage_settings.UsageSettings(
        page_activity=body.page_activity,
        page_activity_since=(
            datetime.now(UTC).isoformat()
            if turned_on
            else before.page_activity_since
            if body.page_activity
            else None
        ),
        usage_retention_days=body.usage_retention_days,
        page_activity_retention_days=body.page_activity_retention_days,
    )
    usage_settings.store(org, after)
    payload: dict = {"before": before.as_dict(), "after": after.as_dict()}
    if before.page_activity and not body.page_activity:
        payload["page_counts_erased"] = await page_activity.erase(db, org_id)
    await record(
        db,
        action=SETTINGS_UPDATED,
        actor_id=actor.id,
        org_id=org_id,
        payload=payload,
        request=request,
    )
    await db.commit()
    return _out(after)
