"""Runs every server project's rules every five minutes, in the server
process, whether or not anyone has the app open.

The loop starts with the API (the automations router's lifespan, merged into
the app's when the router is mounted) and only on a server: in local mode the
desktop app runs its own projects' rules (``main/automations/scheduler.ts``)
and skips the server's. One pass per project at a time: a pass asked for
while one runs (the panel's *Run now*, the next tick) joins it.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from server.db.engine import get_session_factory
from server.db.models import Organization, Project, ProjectAutomation
from sqlalchemy import select

from .live import ServerDeps
from .run import Summary, run_rules
from .store import keep_rules, load, project_lock, save

logger = logging.getLogger(__name__)

PASS_INTERVAL_S = 5 * 60
FIRST_PASS_DELAY_S = 30


async def run_project(project_id: str) -> Summary:
    """One pass over a project's rules; the ledger written at the end."""
    factory = get_session_factory()
    async with factory() as db:
        project = await db.get(Project, project_id)
        if project is None:
            return Summary()
        automations = await load(db, project_id)
        if not any(rule.get("enabled") for rule in automations.rules):
            return Summary()
        deps = ServerDeps(db, project, automations.owners, datetime.now().astimezone())
        summary = await run_rules(automations.rules, automations.ledger, deps)
    async with project_lock(project_id), factory() as db:
        # A rule deleted during the pass takes its history with it.
        current = await load(db, project_id)
        keep_rules(automations.ledger, {rule["id"] for rule in current.rules})
        current.ledger = automations.ledger
        await save(db, current, rules=False)
    return summary


class AutomationScheduler:
    def __init__(self) -> None:
        self._passes: dict[str, asyncio.Task[Summary]] = {}
        self._loop: asyncio.Task[None] | None = None

    def run(self, project_id: str) -> asyncio.Task[Summary]:
        """The project's pass; one already running is joined, not doubled."""
        running = self._passes.get(project_id)
        if running is not None and not running.done():
            return running
        task = asyncio.get_running_loop().create_task(run_project(project_id))
        self._passes[project_id] = task
        task.add_done_callback(lambda _: self._passes.pop(project_id, None))
        return task

    async def run_all(self) -> None:
        async with get_session_factory()() as db:
            rows = await db.execute(
                select(ProjectAutomation.project_id, ProjectAutomation.rules)
                .join(Project, Project.id == ProjectAutomation.project_id)
                .join(Organization, Organization.id == Project.org_id)
                .where(Organization.is_active.is_(True))
            )
            project_ids = [
                project_id
                for project_id, rules in rows
                if any(isinstance(r, dict) and r.get("enabled") for r in rules or [])
            ]
        for project_id in project_ids:
            # One project's failure is that project's: it is logged, the
            # others still run.
            (result,) = await asyncio.gather(
                self.run(project_id), return_exceptions=True
            )
            if isinstance(result, BaseException) and not isinstance(
                result, asyncio.CancelledError
            ):
                logger.error(
                    "Automations: the pass of project %s failed: %r", project_id, result
                )

    async def _forever(self) -> None:
        await asyncio.sleep(FIRST_PASS_DELAY_S)
        while True:
            (result,) = await asyncio.gather(self.run_all(), return_exceptions=True)
            if isinstance(result, BaseException):
                logger.error("Automations: a pass failed: %r", result)
            await asyncio.sleep(PASS_INTERVAL_S)

    def start(self) -> None:
        if self._loop is None or self._loop.done():
            self._loop = asyncio.get_running_loop().create_task(self._forever())

    async def stop(self) -> None:
        tasks = [t for t in (self._loop, *self._passes.values()) if t is not None]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._loop = None


_scheduler: AutomationScheduler | None = None


def get_scheduler() -> AutomationScheduler:
    global _scheduler
    if _scheduler is None:
        _scheduler = AutomationScheduler()
    return _scheduler


@asynccontextmanager
async def lifespan(_app: Any) -> AsyncIterator[None]:
    """Start the loop with a server's API, stop it with it; nothing locally."""
    from server.config import get_settings

    if not get_settings().server_mode:
        yield
        return
    scheduler = get_scheduler()
    scheduler.start()
    try:
        yield
    finally:
        await scheduler.stop()
