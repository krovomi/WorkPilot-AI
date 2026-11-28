"""The organization's usage report: its settings, the report itself, a send now.

- ``GET /admin/usage/report/settings`` (``usage.read``): when and to whom it
  goes, whether the server can send mail at all, who it goes to by default (the
  members whose role reads usage), and the last sends. Each chosen address says
  whether it belongs to a member of the organization: one that does not is
  flagged on the screen, never refused, since a manager outside the server may
  read it.
- ``PUT /admin/usage/report/settings`` (``usage.write``): changes them, audited
  (``usage.report.settings_updated``); a change of recipients is audited apart
  (``usage.report.recipients_changed``) with the addresses added and removed.
- ``GET /admin/usage/report`` (``usage.read``): the report of one day, week or
  month, the one the email carries, so it stays readable without SMTP.
- ``POST /admin/usage/report/send`` (``usage.write``): sends the last report
  now, to its recipients, audited (``usage.report.sent_now``). It does not
  count as the day's scheduled send, which still goes at its hour.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from server.auth.deps import CurrentUser
from server.authz.deps import require_org, require_permission
from server.config import get_settings
from server.db.engine import get_db
from server.db.models import Organization
from server.ratelimit import limiter
from server.services import report_settings, usage_digest, usage_report_schedule
from server.services.audit import record
from server.services.report_settings import ReportSettings
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["usage"])

SETTINGS_UPDATED = "usage.report.settings_updated"
RECIPIENTS_CHANGED = "usage.report.recipients_changed"
SENT_NOW = "usage.report.sent_now"


class ReportSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    enabled: bool
    time: str = Field(min_length=5, max_length=5)
    timezone: str = Field(min_length=1, max_length=64)
    days: list[int] = Field(min_length=1, max_length=7)
    recipients: list[str] = Field(max_length=report_settings.MAX_RECIPIENTS)
    language: Literal["fr", "en"]
    names: bool
    weekly: bool
    monthly: bool


class Recipient(BaseModel):
    address: str
    #: Whether the address belongs to a member of the organization.
    member: bool


class Send(BaseModel):
    kind: str
    period: str
    status: str
    recipients: int
    at: str


class ReportSettingsOut(BaseModel):
    enabled: bool
    time: str
    timezone: str
    days: list[int]
    recipients: list[Recipient]
    language: str
    names: bool
    weekly: bool
    monthly: bool
    #: Whether the server can send mail; without it the report is only read here.
    email_enabled: bool
    #: Who it goes to while no address is chosen.
    default_recipients: list[str]
    last_sends: list[Send]


class SentNow(BaseModel):
    status: str
    recipients: int
    period: str


async def _org(db: AsyncSession, org_id: str) -> Organization:
    org = await db.get(Organization, org_id)
    if org is None:
        raise HTTPException(status_code=404, detail="Organization not found")
    return org


async def _out(
    db: AsyncSession, org_id: str, settings: ReportSettings
) -> ReportSettingsOut:
    members = await usage_report_schedule.member_addresses(db, org_id)
    fields = settings.as_dict()
    fields["recipients"] = [
        Recipient(address=a, member=a in members) for a in settings.recipients
    ]
    return ReportSettingsOut(
        **fields,
        email_enabled=get_settings().email_enabled,
        default_recipients=await usage_report_schedule.readers(db, org_id),
        last_sends=[
            Send(**s) for s in await usage_report_schedule.last_sends(db, org_id)
        ],
    )


def _checked(body: ReportSettingsIn) -> ReportSettings:
    """The settings of ``body``, or a 422 naming what does not read."""
    if not report_settings.valid_time(body.time):
        raise HTTPException(status_code=422, detail="time must be HH:MM")
    if report_settings.zone_of(body.timezone) is None:
        raise HTTPException(status_code=422, detail="Unknown time zone")
    if any(d < 0 or d > 6 for d in body.days):
        raise HTTPException(status_code=422, detail="days go from 0 to 6")
    if not all(report_settings.is_address(a.strip()) for a in body.recipients):
        raise HTTPException(status_code=422, detail="Invalid email address")
    return ReportSettings(
        enabled=body.enabled,
        time=body.time,
        timezone=body.timezone,
        days=tuple(sorted(set(body.days))),
        recipients=report_settings.clean_recipients(
            [a.strip() for a in body.recipients]
        ),
        language=body.language,
        names=body.names,
        weekly=body.weekly,
        monthly=body.monthly,
    )


@router.get(
    "/admin/usage/report/settings",
    response_model=ReportSettingsOut,
    dependencies=[Depends(require_permission("usage.read"))],
)
async def read_report_settings(
    org_id: str = Depends(require_org),
    db: AsyncSession = Depends(get_db),
) -> ReportSettingsOut:
    org = await _org(db, org_id)
    return await _out(db, org_id, report_settings.of(org.settings))


@router.put("/admin/usage/report/settings", response_model=ReportSettingsOut)
async def write_report_settings(
    body: ReportSettingsIn,
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("usage.write")),
    db: AsyncSession = Depends(get_db),
) -> ReportSettingsOut:
    after = _checked(body)
    org = await _org(db, org_id)
    before = report_settings.of(org.settings)
    report_settings.store(org, after)
    shown = {k: v for k, v in after.as_dict().items() if k != "recipients"}
    was = {k: v for k, v in before.as_dict().items() if k != "recipients"}
    if shown != was:
        await record(
            db,
            action=SETTINGS_UPDATED,
            actor_id=actor.id,
            org_id=org_id,
            payload={"before": was, "after": shown},
            request=request,
        )
    added = [a for a in after.recipients if a not in before.recipients]
    removed = [a for a in before.recipients if a not in after.recipients]
    if added or removed:
        await record(
            db,
            action=RECIPIENTS_CHANGED,
            actor_id=actor.id,
            org_id=org_id,
            payload={"added": added, "removed": removed},
            request=request,
        )
    await db.commit()
    return await _out(db, org_id, after)


@router.get(
    "/admin/usage/report",
    dependencies=[Depends(require_permission("usage.read"))],
)
async def read_report(
    kind: usage_digest.Kind = "daily",
    day: date | None = Query(default=None),
    org_id: str = Depends(require_org),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The report of the period of ``kind`` that holds ``day`` (by default the
    last full one, in the organization's own time)."""
    org = await _org(db, org_id)
    settings = report_settings.of(org.settings)
    today = usage_report_schedule.today_in(settings)
    if day is None:
        period = usage_digest.period_of(kind, today)
    elif day >= today:
        raise HTTPException(status_code=422, detail="day must be in the past")
    else:
        period = usage_digest.period_containing(kind, day)
    return await usage_digest.digest(db, org_id, period, names=settings.names)


@router.post("/admin/usage/report/send", response_model=SentNow)
@limiter.limit("5/minute")
async def send_report_now(
    request: Request,
    org_id: str = Depends(require_org),
    actor: CurrentUser = Depends(require_permission("usage.write")),
    db: AsyncSession = Depends(get_db),
) -> SentNow:
    if not get_settings().email_enabled:
        raise HTTPException(status_code=409, detail="SMTP is not configured")
    org = await _org(db, org_id)
    settings = report_settings.of(org.settings)
    today = usage_report_schedule.today_in(settings)
    period = usage_digest.period_of("daily", today)
    status, count = await usage_report_schedule.deliver(db, org_id, settings, period)
    await record(
        db,
        action=SENT_NOW,
        actor_id=actor.id,
        org_id=org_id,
        payload={
            "kind": period.kind,
            "period": period.start.isoformat(),
            "status": status,
            "recipients": count,
        },
        request=request,
    )
    await db.commit()
    return SentNow(status=status, recipients=count, period=period.start.isoformat())
