"""The server's figures in the Prometheus text format, for ``/metrics``.

Written by hand (format 0.0.4): no client library, no new dependency. Every
figure is a gauge read from the database or the disk when the scraper asks,
so two server processes answer the same numbers.

Nothing here is about a person: counts per organization (by its slug), per
provider and per state, never a user, a project, a model's prompt or a path.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime

from server.db.models import (
    AgentRun,
    Organization,
    PresenceDay,
    ProjectJob,
    UsageRecord,
    User,
)
from server.services import server_health
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
_LEVEL = {"ok": 0, "degraded": 1, "error": 2}
_TOKENS = (
    UsageRecord.input_tokens
    + UsageRecord.output_tokens
    + UsageRecord.cache_write_tokens
    + UsageRecord.cache_read_tokens
)


def _label(value: object) -> str:
    text = str(value)
    return text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


class Exposition:
    """Lines of the text format, one ``# HELP`` and ``# TYPE`` per metric."""

    def __init__(self) -> None:
        self.lines: list[str] = []

    def gauge(
        self,
        name: str,
        help_text: str,
        samples: Iterable[tuple[dict[str, object], float | int]],
    ) -> None:
        self.lines.append(f"# HELP {name} {help_text}")
        self.lines.append(f"# TYPE {name} gauge")
        for labels, value in samples:
            shown = ",".join(f'{k}="{_label(v)}"' for k, v in sorted(labels.items()))
            key = f"{name}{{{shown}}}" if shown else name
            self.lines.append(f"{key} {value}")

    def text(self) -> str:
        return "\n".join(self.lines) + "\n"


async def _by_state(db: AsyncSession, model) -> list[tuple[dict, int]]:
    rows = (
        await db.execute(
            select(model.status, func.count(model.id)).group_by(model.status)
        )
    ).all()
    return [({"status": status}, count) for status, count in sorted(rows)]


async def render(db: AsyncSession, now: datetime | None = None) -> str:
    """Every figure, as the scraper reads them."""
    now = now or datetime.now(UTC)
    month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    health = await server_health.report(db)
    checks = health["checks"]
    out = Exposition()
    out.gauge(
        "workpilot_info",
        "The server's version.",
        [({"version": checks["version"]["version"]}, 1)],
    )
    out.gauge(
        "workpilot_health_status",
        "Health of each check: 0 ok, 1 degraded, 2 error.",
        [({"check": name}, _LEVEL.get(c["status"], 0)) for name, c in checks.items()],
    )
    out.gauge(
        "workpilot_database_latency_milliseconds",
        "How long a SELECT 1 took.",
        [({}, checks["database"].get("latency_ms", -1))],
    )
    volumes = [v for v in checks["disk"]["volumes"] if "free_bytes" in v]
    out.gauge(
        "workpilot_disk_free_bytes",
        "Free space of the volume holding each part of the server's data.",
        [({"volume": v["name"]}, v["free_bytes"]) for v in volumes],
    )
    out.gauge(
        "workpilot_disk_total_bytes",
        "Size of that volume.",
        [({"volume": v["name"]}, v["total_bytes"]) for v in volumes],
    )
    abi = checks["isolation"]["landlock_abi"]
    out.gauge(
        "workpilot_landlock_abi",
        "The Landlock ABI the kernel speaks, -1 without Landlock.",
        [({}, abi if abi is not None else -1)],
    )
    out.gauge(
        "workpilot_runs",
        "Agent runs the database holds, by status.",
        await _by_state(db, AgentRun),
    )
    out.gauge(
        "workpilot_jobs",
        "Project jobs the database holds, by status.",
        await _by_state(db, ProjectJob),
    )
    out.gauge(
        "workpilot_max_concurrent_runs",
        "Runs and jobs the server runs at once.",
        [({}, checks["queue"]["max_concurrent"])],
    )
    slugs = dict((await db.execute(select(Organization.id, Organization.slug))).all())
    tokens = (
        await db.execute(
            select(
                UsageRecord.org_id,
                UsageRecord.provider,
                func.coalesce(func.sum(_TOKENS), 0),
            )
            .where(UsageRecord.created_at >= month)
            .group_by(UsageRecord.org_id, UsageRecord.provider)
        )
    ).all()
    out.gauge(
        "workpilot_tokens_this_month",
        "Tokens used since the first of the month (UTC), by organization and provider.",
        sorted(
            (
                (
                    {
                        "org": slugs.get(org, "unknown"),
                        "provider": provider or "unknown",
                    },
                    int(total),
                )
                for org, provider, total in tokens
            ),
            key=lambda sample: sorted(sample[0].items()),
        ),
    )
    present = (
        await db.execute(
            select(PresenceDay.org_id, func.count(func.distinct(PresenceDay.user_id)))
            .where(PresenceDay.day == now.date(), PresenceDay.user_id.is_not(None))
            .group_by(PresenceDay.org_id)
        )
    ).all()
    out.gauge(
        "workpilot_active_people_today",
        "People who used the server today (UTC), by organization.",
        sorted(
            (({"org": slugs.get(org, "unknown")}, n) for org, n in present),
            key=lambda sample: str(sample[0]["org"]),
        ),
    )
    out.gauge(
        "workpilot_organizations",
        "Active organizations.",
        [
            (
                {},
                int(
                    await db.scalar(
                        select(func.count(Organization.id)).where(
                            Organization.is_active.is_(True)
                        )
                    )
                    or 0
                ),
            )
        ],
    )
    out.gauge(
        "workpilot_accounts",
        "Active accounts.",
        [
            (
                {},
                int(
                    await db.scalar(
                        select(func.count(User.id)).where(User.is_active.is_(True))
                    )
                    or 0
                ),
            )
        ],
    )
    return out.text()
