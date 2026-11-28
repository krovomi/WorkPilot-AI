"""Which pages people open, per day: off unless their organization turns it on.

The desktop and the phone count, for the person signed in, how many times each
page was opened today, and send the counts in batches
(``POST /users/me/page-activity``). The server keeps one row per person,
organization, day, app and page (``page_visits``), and only:

- while the organization has page activity on (:mod:`server.services.usage_settings`,
  off by default; each organization turns it on once its members are told);
- for a page of :data:`PAGES`, the closed list of each app's screens: a name
  outside it refuses the whole batch, so no project, card, path or typed text
  can come in as a page name;
- for today or yesterday (a batch sent just after midnight), never a day
  further back or ahead.

Turning page activity off erases the organization's rows at once; otherwise
they are erased past the retention (``services/usage_retention.py``).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta

from server.db.models import PageVisit
from sqlalchemy import delete, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

#: The desktop's views (``SidebarView``, ``renderer/components/Sidebar.tsx``),
#: as ``shared/constants/page-activity.ts`` lists them.
DESKTOP_PAGES: frozenset[str] = frozenset(
    {
        "kanban",
        "terminals",
        "roadmap",
        "context",
        "ideation",
        "github-issues",
        "gitlab-issues",
        "github-prs",
        "gitlab-merge-requests",
        "bitbucket-issues",
        "bitbucket-pull-requests",
        "changelog",
        "insights",
        "worktrees",
        "agent-tools",
        "migration",
        "architecture-visualizer",
        "performance-profiler",
        "visual-to-code",
        "dashboard",
        "analytics",
        "code-review",
        "refactoring",
        "documentation",
        "cost-estimator",
        "session-history",
        "voice-control",
        "test-generation",
        "prompt-optimizer",
        "code-playground",
        "dependency-sentinel",
        "natural-language-git",
        "conflict-predictor",
        "context-aware-snippets",
        "app-emulator",
        "learning-loop",
        "mcp-marketplace",
        "mission-control",
        "agent-replay",
        "pixel-office",
        "self-healing",
        "browser-agent",
        "pair-programming",
        "pipeline-generator",
        "plugin-marketplace",
        "arena-mode",
        "api-explorer",
        "sandbox",
        "regression-guardian",
        "injection-guard",
        "api-watcher",
        "accessibility-agent",
        "i18n-agent",
        "onboarding-agent",
        "onboarding-guide",
        "flaky-tests",
        "doc-drift",
        "compliance",
        "git-surgeon",
        "release-coordinator",
        "carbon-profiler",
        "consensus-arbiter",
        "notebook-agent",
        "agent-coach",
        "bounty-board",
        "repo-bench",
        "tech-debt",
        "agent-debugger",
        "team-bot",
        "blast-radius",
        "guardrails",
        "env-snapshot",
        "offline-mode",
        "cicd-triggers",
        "cross-language-translation",
        "spec-approval",
        "live-companion",
        "context-mesh",
        "administration",
        "phase35-hub",
        "smart-estimation",
    }
)

#: The phone's screens, as ``apps/mobile/src/usage/pages.ts`` names them from
#: their route (``projects/[projectId]/cards/[cardId]`` is ``projects/cards/detail``).
MOBILE_PAGES: frozenset[str] = frozenset(
    {
        "home",
        "inbox",
        "needs-you",
        "admin",
        "admin/groups",
        "admin/groups/detail",
        "admin/invitations",
        "admin/members",
        "admin/roles",
        "admin/roles/detail",
        "projects",
        "projects/analyses",
        "projects/analyses/detail",
        "projects/cards/detail",
        "projects/cards/files",
        "projects/cards/logs",
        "projects/chat",
        "projects/context",
        "projects/dashboard",
        "projects/delegations",
        "projects/forge",
        "projects/forge/issues/detail",
        "projects/forge/pulls/detail",
        "projects/governance",
        "projects/ideas",
        "projects/insights",
        "projects/insights/detail",
        "projects/leaderboard",
        "projects/more",
        "projects/new",
        "projects/roadmap",
        "projects/sessions",
        "projects/waves",
        "replays",
        "settings",
        "share",
        "tokens",
    }
)

PAGES: dict[str, frozenset[str]] = {"desktop": DESKTOP_PAGES, "mobile": MOBILE_PAGES}
#: At most this many (day, page) counts per batch, and per count.
MAX_VISITS = 200
MAX_COUNT = 10_000


@dataclass(frozen=True)
class Visit:
    day: date
    page: str
    count: int


class UnknownPage(ValueError):
    """A client or a page outside the closed lists."""


def check(client: str, visits: Iterable[Visit]) -> None:
    """Refuse a batch naming an app or a page the lists do not have."""
    pages = PAGES.get(client)
    if pages is None:
        raise UnknownPage("Unknown app")
    for visit in visits:
        if visit.page not in pages:
            raise UnknownPage("Unknown page")


async def record(
    db: AsyncSession,
    *,
    user_id: str,
    org_id: str,
    client: str,
    visits: list[Visit],
    today: date,
) -> int:
    """Add the batch's counts to the person's rows; the opens recorded.

    The caller checked the batch (:func:`check`) and that the organization has
    page activity on. A count for another day than today or yesterday is
    dropped.
    """
    totals: dict[tuple[date, str], int] = {}
    for visit in visits:
        if visit.day not in (today, today - timedelta(days=1)) or visit.count < 1:
            continue
        key = (visit.day, visit.page)
        totals[key] = min(totals.get(key, 0) + visit.count, MAX_COUNT)
    if not totals:
        return 0
    for attempt in (1, 2):
        try:
            await _add(db, user_id, org_id, client, totals)
            await db.commit()
            break
        except IntegrityError:
            # Another batch of the same person added a row first: read again.
            await db.rollback()
            if attempt == 2:
                raise
    return sum(totals.values())


async def _add(
    db: AsyncSession,
    user_id: str,
    org_id: str,
    client: str,
    totals: dict[tuple[date, str], int],
) -> None:
    rows = {
        (row.day, row.page): row
        for row in await db.scalars(
            select(PageVisit).where(
                PageVisit.user_id == user_id,
                PageVisit.org_id == org_id,
                PageVisit.client == client,
                PageVisit.day.in_({day for day, _ in totals}),
            )
        )
    }
    for (day, page), count in totals.items():
        row = rows.get((day, page))
        if row is None:
            db.add(
                PageVisit(
                    user_id=user_id,
                    org_id=org_id,
                    day=day,
                    client=client,
                    page=page,
                    count=count,
                )
            )
        else:
            row.count = min(row.count + count, MAX_COUNT)
    await db.flush()


async def erase(db: AsyncSession, org_id: str) -> int:
    """Erase every page count of an organization (page activity turned off)."""
    result = await db.execute(delete(PageVisit).where(PageVisit.org_id == org_id))
    return result.rowcount or 0
