"""The Usage tab's figures: ``/admin/usage/*`` and its platform-wide twin.

Every view is served twice, by one function: under ``/admin/usage`` for the
organization the caller acts in (``usage.read``), and under
``/admin/platform/usage`` for the whole deployment (its administrators only).
The period is ``start``..``end`` (UTC days, both included; the last 30 days by
default, at most :data:`~server.services.usage_report.MAX_PERIOD_DAYS`); the
filters name a person, a group, a project, a provider or a model. A group or
a project of another organization answers 404, as one that does not exist.

``/export`` gives one table as CSV, and enters the audit log: these tables
name people.
"""

from __future__ import annotations

import csv
import io
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from server.authz.deps import require_org, require_permission, require_platform_admin
from server.authz.principal import Principal
from server.db.engine import get_db
from server.db.models import Project, User, UserGroup
from server.services import usage_delivery, usage_report
from server.services.audit import record
from server.services.usage_report import Scope
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["usage"])

DEFAULT_DAYS = 30
_NAME = r"^[A-Za-z0-9._:/@+-]{1,120}$"
_ID = r"^[A-Za-z0-9-]{1,36}$"

View = Literal["daily", "people", "models", "phases", "projects", "pages", "failures"]


def period(
    start: date | None = Query(None),
    end: date | None = Query(None),
    user_id: str | None = Query(None, pattern=_ID),
    group_id: str | None = Query(None, pattern=_ID),
    project_id: str | None = Query(None, pattern=_ID),
    provider: str | None = Query(None, pattern=_NAME),
    model: str | None = Query(None, pattern=_NAME),
) -> Scope:
    """The period and filters asked, checked; the organization comes after."""
    last = end or datetime.now(UTC).date()
    first = start or last - timedelta(days=DEFAULT_DAYS - 1)
    if first > last:
        raise HTTPException(status_code=422, detail="The period ends before it starts")
    if (last - first).days >= usage_report.MAX_PERIOD_DAYS:
        raise HTTPException(status_code=422, detail="The period is too long")
    return Scope(
        None,
        first,
        last,
        user_id=user_id,
        group_id=group_id,
        project_id=project_id,
        provider=provider,
        model=model,
    )


async def org_scope(
    asked: Scope = Depends(period),
    org_id: str = Depends(require_org),
    _: Principal = Depends(require_permission("usage.read")),
    db: AsyncSession = Depends(get_db),
) -> Scope:
    if asked.group_id:
        group = await db.get(UserGroup, asked.group_id)
        if group is None or group.org_id != org_id:
            raise HTTPException(status_code=404, detail="Group not found")
    if asked.project_id:
        project = await db.get(Project, asked.project_id)
        if project is None or project.org_id != org_id:
            raise HTTPException(status_code=404, detail="Project not found")
    return Scope(
        org_id,
        asked.start,
        asked.end,
        user_id=asked.user_id,
        group_id=asked.group_id,
        project_id=asked.project_id,
        provider=asked.provider,
        model=asked.model,
    )


def platform_scope(
    asked: Scope = Depends(period),
    _: Principal = Depends(require_platform_admin),
) -> Scope:
    return asked


def _cell(value: object) -> str:
    """A spreadsheet never reads a cell as a formula (names are people's text)."""
    if value is None:
        return ""
    if isinstance(value, list):
        value = " ".join(str(v) for v in value)
    text = str(value)
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


_COLUMNS: dict[str, tuple[str, ...]] = {
    "daily": ("day", "provider", "tokens", "cost_usd"),
    "people": (
        "name",
        "email",
        "runs",
        "jobs",
        "tokens",
        "cost_usd",
        "providers",
        "models",
        "last_seen_at",
    ),
    "models": (
        "provider",
        "model",
        "sessions",
        "runs",
        "succeeded",
        "failed",
        "success_rate",
        "tokens",
        "cost_usd",
        "cost_per_run_usd",
    ),
    "phases": (
        "phase",
        "provider",
        "model",
        "runs",
        "succeeded",
        "failed",
        "success_rate",
        "tokens",
        "cost_usd",
        "cost_per_run_usd",
    ),
    "projects": ("name", "runs", "tokens", "cost_usd"),
    "pages": ("client", "page", "opens", "people"),
    "failures": ("cause", "runs", "jobs"),
}


async def _rows(db: AsyncSession, scope: Scope, view: str) -> list[dict]:
    if view == "daily":
        return await usage_report.daily(db, scope)
    if view == "people":
        return await usage_report.people(db, scope)
    if view in ("models", "phases"):
        return (await usage_report.models(db, scope))[view]
    if view == "projects":
        return await usage_report.projects(db, scope)
    if view == "pages":
        return (await usage_report.pages(db, scope))["pages"]
    return (await usage_delivery.delivery(db, scope))["failures"]


def csv_of(view: str, rows: list[dict]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    columns = _COLUMNS[view]
    writer.writerow(columns)
    for row in rows:
        writer.writerow([_cell(row.get(column)) for column in columns])
    return out.getvalue()


def _serve(prefix: str, scope_of: Callable) -> None:
    """The views, under ``prefix``, for the scope ``scope_of`` grants."""

    @router.get(f"{prefix}/summary")
    async def usage_summary(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> dict:
        return await usage_report.summary(db, scope)

    @router.get(f"{prefix}/daily")
    async def usage_daily(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> list[dict]:
        return await usage_report.daily(db, scope)

    @router.get(f"{prefix}/people")
    async def usage_people(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> list[dict]:
        return await usage_report.people(db, scope)

    @router.get(f"{prefix}/people/{{person_id}}")
    async def usage_person(
        person_id: str,
        scope: Scope = Depends(scope_of),
        db: AsyncSession = Depends(get_db),
    ) -> dict:
        if not await usage_report.is_person_of(db, scope.org_id, person_id):
            raise HTTPException(status_code=404, detail="Person not found")
        user = await db.get(User, person_id)
        mine = scope.of_person(person_id)
        return {
            "user": {
                "user_id": person_id,
                "name": user.display_name if user else None,
                "email": user.email if user else None,
            },
            "summary": await usage_report.summary(db, mine),
            "daily": await usage_report.daily(db, mine),
            "timeline": await usage_report.timeline(db, mine),
            "pages": await usage_report.pages(db, mine),
        }

    @router.get(f"{prefix}/models")
    async def usage_models(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> dict:
        return await usage_report.models(db, scope)

    @router.get(f"{prefix}/projects")
    async def usage_projects(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> list[dict]:
        return await usage_report.projects(db, scope)

    @router.get(f"{prefix}/pages")
    async def usage_pages(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> dict:
        return await usage_report.pages(db, scope)

    @router.get(f"{prefix}/delivery")
    async def usage_delivery_view(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> dict:
        return await usage_delivery.delivery(db, scope)

    @router.get(f"{prefix}/presence")
    async def usage_presence(
        scope: Scope = Depends(scope_of), db: AsyncSession = Depends(get_db)
    ) -> dict:
        return await usage_delivery.presence(db, scope.org_id, datetime.now(UTC))

    @router.get(f"{prefix}/export")
    async def usage_export(
        request: Request,
        view: View = Query(...),
        scope: Scope = Depends(scope_of),
        db: AsyncSession = Depends(get_db),
    ) -> Response:
        rows = await _rows(db, scope, view)
        await record(
            db,
            action="usage.exported",
            actor_id=getattr(request.state, "user_id", None),
            org_id=scope.org_id,
            payload={
                "view": view,
                "start": scope.start.isoformat(),
                "end": scope.end.isoformat(),
                "rows": len(rows),
            },
            request=request,
        )
        await db.commit()
        name = f"workpilot-usage-{view}-{scope.start}-{scope.end}.csv"
        return Response(
            content=csv_of(view, rows),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{name}"'},
        )


_serve("/admin/usage", org_scope)
_serve("/admin/platform/usage", platform_scope)
