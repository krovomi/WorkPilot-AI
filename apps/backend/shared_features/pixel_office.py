"""Pixel Office's team leaderboard and each person's badges, on a server (#350).

On the desktop, Pixel Office's achievements and seasons belong to a project:
nothing says who did the work. A server knows: who launched the build that
delivered a card (``agent_runs.started_by``) and who approved a card someone
else wrote (``spec_approvals``). Everything here is computed on the server,
from its own database and the clone's files, and sent only to the person who
asks; nothing is sent anywhere else.

- **What counts.** A delivered card (status ``done`` or ``pr_created``) is
  credited to the person who launched its last successful build, and weighs
  what the spec agent assessed its complexity at (``complexity_assessment
  .json``, read through ``approval_policy.assessed_criticality``): 1, 2 or 3
  points, 1 when it was not assessed. A person's own choice of criticality is
  not read, so nobody raises their own score. An approval of a card that
  someone else wrote and delivered counts as help, ``REVIEW_POINTS`` each,
  once per card and person: reviewing weighs like delivering a standard
  card, so the board does not reward working alone. No token count and no
  price is read: the same work scores the same on every provider.
- **Who is named.** Nobody, unless they said yes (``leaderboard_consents``,
  per organization, written only by the person). Without it, a person's work
  is counted for them alone: the answer's ``me`` is the caller's own score
  and badges, whatever they chose; ``entries`` lists only the people who
  agreed. No total of the others is given, since with one person missing it
  would be theirs.
- **Where.** ``scope=project`` reads the project named by ``project_id``;
  ``scope=org`` reads every project of its organization the caller may read
  themselves (``load_project_scope``), at most ``MAX_PROJECTS``.
  ``period=season`` is the current calendar quarter (UTC), ``all`` is since
  the start. Badges are always counted since the start.

Both routes take a ``project_id`` and resolve it (``resolve_project_scope``):
another tenant's project answers 404. Reading is ``analytics.read``; saving
one's own consent is the same right (``server.authz.mounting``), since it
changes nothing but the caller's own row.
"""

from __future__ import annotations

import asyncio
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, StrictBool
from server.authz.principal import Principal, get_principal
from server.authz.scope import ProjectScope, load_project_scope, resolve_project_scope
from server.db.engine import get_db
from server.db.models import (
    AgentRun,
    LeaderboardConsent,
    Project,
    SpecApproval,
    SpecIndex,
    User,
)
from server.services import audit
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/api/features/pixel-office", tags=["features"])

DELIVERED = ("done", "pr_created")
#: Points of a delivered card, by the complexity its spec was assessed at.
COMPLEXITY_POINTS = {"low": 1, "medium": 2, "high": 3}
UNASSESSED_POINTS = 1
REVIEW_POINTS = 2
#: What is read, at most: projects, delivered cards, approvals, people listed.
MAX_PROJECTS = 100
MAX_CARDS = 5_000
MAX_APPROVALS = 20_000
MAX_ENTRIES = 50
NAME_MAX = 200

#: A person's badges, counted since the start: (id, fact, threshold).
BADGES: tuple[tuple[str, str, int], ...] = (
    ("first_delivery", "delivered", 1),
    ("ten_deliveries", "delivered", 10),
    ("complex_delivery", "complex", 1),
    ("first_review", "reviews", 1),
    ("ten_reviews", "reviews", 10),
)


class ConsentRequest(BaseModel):
    visible: StrictBool


@dataclass
class _Tally:
    delivered: int = 0
    reviews: int = 0
    points: int = 0
    complex: int = 0

    def badge_ids(self) -> list[str]:
        return [
            badge for badge, fact, needed in BADGES if getattr(self, fact) >= needed
        ]


@dataclass
class _Facts:
    """Each person's tally in the period, and since the start."""

    period: dict[str, _Tally] = field(default_factory=lambda: defaultdict(_Tally))
    ever: dict[str, _Tally] = field(default_factory=lambda: defaultdict(_Tally))


def _aware(moment: datetime | None) -> datetime | None:
    """A timestamp of the database in UTC (SQLite gives them back naive)."""
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def season_bounds(now: datetime) -> tuple[datetime, datetime]:
    """The calendar quarter (UTC) that holds ``now``: its first instant and
    the first instant of the next one."""
    first_month = (now.month - 1) // 3 * 3 + 1
    start = datetime(now.year, first_month, 1, tzinfo=UTC)
    if first_month == 10:
        return start, datetime(now.year + 1, 1, 1, tzinfo=UTC)
    return start, datetime(now.year, first_month + 3, 1, tzinfo=UTC)


def _within(moment: datetime | None, bounds: tuple[datetime, datetime] | None) -> bool:
    if bounds is None:
        return True
    aware = _aware(moment)
    return aware is not None and bounds[0] <= aware < bounds[1]


def card_points(clone: Path, spec_name: str) -> tuple[int, bool]:
    """What a delivered card weighs, and whether it was assessed complex."""
    from board_mcp.server import card_dir
    from server.authz.approval_policy import assessed_criticality

    tier = assessed_criticality(card_dir(clone, spec_name))
    if tier is None:
        return UNASSESSED_POINTS, False
    return COMPLEXITY_POINTS[tier], tier == "high"


async def _readable_projects(
    db: AsyncSession, scope: ProjectScope, principal: Principal, wide: bool
) -> dict[str, Path]:
    """The projects counted: the one named, or each of its organization's
    the caller may read themselves."""
    if not wide:
        return {scope.project_id: scope.path}
    ids = await db.scalars(
        select(Project.id)
        .where(Project.org_id == scope.org_id)
        .order_by(Project.created_at)
        .limit(MAX_PROJECTS)
    )
    readable: dict[str, Path] = {}
    for project_id in ids.all():
        try:
            peer = await load_project_scope(db, principal, project_id)
        except HTTPException:
            continue
        readable[peer.project_id] = peer.path
    return readable


async def _deliveries(
    db: AsyncSession, projects: dict[str, Path]
) -> list[tuple[str, str, str, datetime | None]]:
    """``(project, card, person, delivered at)`` for each delivered card a
    person's successful build delivered (the last such build's person)."""
    rows = await db.execute(
        select(
            SpecIndex.id,
            SpecIndex.project_id,
            SpecIndex.spec_name,
            SpecIndex.updated_at,
            AgentRun.started_by,
        )
        .join(AgentRun, AgentRun.spec_id == SpecIndex.id)
        .where(
            SpecIndex.project_id.in_(list(projects)),
            SpecIndex.status.in_(DELIVERED),
            AgentRun.phase == "build",
            AgentRun.status == "succeeded",
            AgentRun.started_by.is_not(None),
        )
        .order_by(AgentRun.started_at.desc())
        .limit(MAX_CARDS * 4)
    )
    latest: dict[str, tuple[str, str, str, datetime | None]] = {}
    for spec_id, project_id, spec_name, updated_at, person in rows.all():
        latest.setdefault(spec_id, (project_id, spec_name, person, updated_at))
    return list(latest.values())[:MAX_CARDS]


async def _approvals(
    db: AsyncSession, projects: dict[str, Path]
) -> list[tuple[str, str, str, datetime | None]]:
    """``(project, card, person, first approved at)`` for each card a person
    approved that someone else wrote."""
    rows = await db.execute(
        select(
            SpecApproval.project_id,
            SpecApproval.spec_name,
            SpecApproval.user_id,
            func.min(SpecApproval.created_at),
        )
        .join(
            SpecIndex,
            (SpecIndex.project_id == SpecApproval.project_id)
            & (SpecIndex.spec_name == SpecApproval.spec_name),
            isouter=True,
        )
        .where(
            SpecApproval.project_id.in_(list(projects)),
            SpecApproval.user_id.is_not(None),
            (SpecIndex.created_by.is_(None))
            | (SpecIndex.created_by != SpecApproval.user_id),
        )
        .group_by(SpecApproval.project_id, SpecApproval.spec_name, SpecApproval.user_id)
        .limit(MAX_APPROVALS)
    )
    return [(p, s, u, at) for p, s, u, at in rows.all()]


async def collect_facts(
    db: AsyncSession,
    projects: dict[str, Path],
    bounds: tuple[datetime, datetime] | None,
) -> _Facts:
    facts = _Facts()
    deliveries = await _deliveries(db, projects)
    delivered_by = {(p, s): person for p, s, person, _at in deliveries}
    weights = await asyncio.to_thread(
        lambda: [card_points(projects[p], s) for p, s, _person, _at in deliveries]
    )
    for (_p, _s, person, at), (points, complex_card) in zip(
        deliveries, weights, strict=True
    ):
        tallies = [facts.ever[person]]
        if _within(at, bounds):
            tallies.append(facts.period[person])
        for tally in tallies:
            tally.delivered += 1
            tally.points += points
            tally.complex += int(complex_card)
    for project_id, spec_name, person, at in await _approvals(db, projects):
        if delivered_by.get((project_id, spec_name)) == person:
            continue
        tallies = [facts.ever[person]]
        if _within(at, bounds):
            tallies.append(facts.period[person])
        for tally in tallies:
            tally.reviews += 1
            tally.points += REVIEW_POINTS
    return facts


async def _named(db: AsyncSession, org_id: str, people: set[str]) -> dict[str, str]:
    """The name of each of ``people`` who agreed to show by name in ``org_id``."""
    if not people:
        return {}
    rows = await db.execute(
        select(User.id, User.display_name, User.email)
        .join(LeaderboardConsent, LeaderboardConsent.user_id == User.id)
        .where(
            LeaderboardConsent.org_id == org_id,
            LeaderboardConsent.visible.is_(True),
            User.id.in_(list(people)),
        )
    )
    return {
        uid: " ".join((display or email or "").split())[:NAME_MAX]
        for uid, display, email in rows.all()
    }


async def _visible(db: AsyncSession, org_id: str, person: str) -> bool:
    row = await db.get(LeaderboardConsent, (org_id, person))
    return bool(row is not None and row.visible)


def ranked(
    period: dict[str, _Tally], ever: dict[str, _Tally], names: dict[str, str], me: str
) -> list[dict[str, Any]]:
    """The people named, by points then name; equal points share a rank."""
    people = sorted(
        (uid for uid in names if period.get(uid) and period[uid].points > 0),
        key=lambda uid: (-period[uid].points, names[uid].casefold(), uid),
    )[:MAX_ENTRIES]
    entries: list[dict[str, Any]] = []
    for index, uid in enumerate(people):
        tally = period[uid]
        rank = index + 1
        if entries and entries[-1]["points"] == tally.points:
            rank = entries[-1]["rank"]
        entries.append(
            {
                "rank": rank,
                "name": names[uid],
                "delivered": tally.delivered,
                "reviews": tally.reviews,
                "points": tally.points,
                "badges": ever[uid].badge_ids(),
                "you": uid == me,
            }
        )
    return entries


@router.get("/leaderboard")
async def leaderboard(
    scope_name: Literal["project", "org"] = Query("project", alias="scope"),
    period: Literal["season", "all"] = Query("season"),
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """The leaderboard of the project or of its organization, and the
    caller's own score and badges."""
    now = datetime.now(UTC)
    start, end = season_bounds(now)
    bounds = (start, end) if period == "season" else None
    projects = await _readable_projects(db, scope, principal, scope_name == "org")
    facts = await collect_facts(db, projects, bounds)
    names = await _named(db, scope.org_id, set(facts.period))
    entries = ranked(facts.period, facts.ever, names, principal.id)
    mine = facts.period.get(principal.id) or _Tally()
    own_rank = next((e["rank"] for e in entries if e["you"]), None)
    return {
        "scope": scope_name,
        "period": period,
        "season": {"start": start.isoformat(), "end": end.isoformat()},
        "projects": len(projects),
        "entries": entries,
        "me": {
            "visible": await _visible(db, scope.org_id, principal.id),
            "delivered": mine.delivered,
            "reviews": mine.reviews,
            "points": mine.points,
            "badges": (facts.ever.get(principal.id) or _Tally()).badge_ids(),
            "rank": own_rank,
        },
    }


@router.put("/consent")
async def set_consent(
    req: ConsentRequest,
    request: Request,
    scope: ProjectScope = Depends(resolve_project_scope),
    principal: Principal = Depends(get_principal),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Show, or stop showing, the caller's name on the leaderboards of the
    project's organization. Only the caller's own row is written."""
    row = await db.get(LeaderboardConsent, (scope.org_id, principal.id))
    if row is None:
        row = LeaderboardConsent(org_id=scope.org_id, user_id=principal.id)
        db.add(row)
    row.visible = req.visible
    row.updated_at = datetime.now(UTC)
    await audit.record(
        db,
        action="pixel_office.leaderboard.consent",
        actor_id=principal.id,
        org_id=scope.org_id,
        payload={"visible": req.visible},
        request=request,
    )
    await db.commit()
    return {"visible": req.visible}
