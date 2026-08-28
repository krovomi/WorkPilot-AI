"""The loop that makes `TriggerType.SCHEDULE` mean something.

`Trigger.cron_expression` was modelled, serialised, round-tripped and rendered
in the hook editor. `scheduling/scheduler.py` had a complete cron parser. The
two were never introduced: `hook_service.py` contained no reference to time at
all, so a user could save a hook that said "every morning at 9" and it would
wait forever.

This is the missing half — deliberately the smaller one. It owns no schedule
state of its own, invents no second cron dialect, and decides nothing about
what a hook does. It answers one question once a minute: which active hooks
say they are due now? Everything after that is `HookService.emit_event`, the
same path a manual or webhook-driven event takes.

Why polling, and why a minute
-----------------------------
Cron expressions have minute precision, so a tighter loop cannot fire anything
sooner — it would only re-ask a question whose answer cannot have changed.
Sleeping until the next occurrence instead would be cheaper still, but hooks
are edited while the process runs, and a sleeping task would have to be torn
down and rebuilt on every edit for no gain at this cadence.

Missed minutes are not replayed. If the app was closed at 09:00, the 09:00 run
did not happen, and firing it at 11:00 because the process happened to start
then would be a surprise, not a recovery — the user asked for 9am, not for
"whenever WorkPilot next opens".
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING

from .models import HookEvent, TriggerType

if TYPE_CHECKING:  # pragma: no cover
    from .models import Hook, Trigger

logger = logging.getLogger(__name__)

__all__ = ["HookScheduler", "start_hook_scheduler", "stop_hook_scheduler"]

# Cron resolves to the minute, so this is the fastest cadence that can change
# an answer.
POLL_SECONDS = 60


class HookScheduler:
    """Fires scheduled hooks. One instance per process."""

    def __init__(self, poll_seconds: int = POLL_SECONDS) -> None:
        self.poll_seconds = poll_seconds
        self._task: asyncio.Task | None = None
        # (hook_id, trigger_id) -> the minute already fired, so a poll that
        # overlaps a minute boundary cannot fire the same schedule twice.
        self._last_fired: dict[tuple[str, str], str] = {}

    # ── lifecycle ────────────────────────────────────────────────────────

    def start(self) -> None:
        """Begin polling. Idempotent."""
        if self._task is not None and not self._task.done():
            return
        self._task = asyncio.create_task(self._run())
        logger.info("hook scheduler started (every %ds)", self.poll_seconds)

    async def stop(self) -> None:
        """Stop polling and wait for the loop to unwind."""
        if self._task is None:
            return
        self._task.cancel()
        try:
            await self._task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        self._task = None
        logger.info("hook scheduler stopped")

    # ── the loop ─────────────────────────────────────────────────────────

    async def _run(self) -> None:
        while True:
            try:
                await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - a bad hook must not end the loop
                logger.warning("hook scheduler tick failed: %s", exc)
            await asyncio.sleep(self.poll_seconds)

    async def tick(self, now: datetime | None = None) -> int:
        """Fire every hook due at ``now``. Returns how many were fired.

        Separated from the loop so a test can drive one minute at a time
        without waiting for a real one.
        """
        moment = now or datetime.now(timezone.utc)
        stamp = moment.strftime("%Y-%m-%dT%H:%M")
        fired = 0

        for hook, trigger in self._due(moment):
            token = (hook.id, trigger.id)
            if self._last_fired.get(token) == stamp:
                continue
            self._last_fired[token] = stamp
            fired += 1
            await self._fire(hook, trigger, moment)

        return fired

    def _due(self, moment: datetime) -> list[tuple[Hook, Trigger]]:
        """Active hooks whose cron expression matches ``moment``."""
        from .hook_service import HookService

        try:
            from scheduling.scheduler import CronExpression
        except Exception as exc:  # noqa: BLE001
            logger.debug("cron parser unavailable, no schedules run: %s", exc)
            return []

        due: list[tuple[Hook, Trigger]] = []
        for hook in HookService.get_instance().active_hooks():
            for trigger in hook.triggers:
                if trigger.type is not TriggerType.SCHEDULE:
                    continue
                expression = (trigger.cron_expression or "").strip()
                if not expression:
                    # A schedule trigger with no expression is an unfinished
                    # hook, not an every-minute one.
                    continue
                try:
                    if CronExpression(expression).matches(moment):
                        due.append((hook, trigger))
                except Exception as exc:  # noqa: BLE001 - one bad expression only
                    logger.debug(
                        "hook %s has an invalid cron expression %r: %s",
                        hook.id,
                        expression,
                        exc,
                    )
        return due

    async def _fire(self, hook: Hook, trigger: Trigger, moment: datetime) -> None:
        """Emit the SCHEDULE event for one due hook."""
        from .hook_service import HookService

        event = HookEvent(
            type=TriggerType.SCHEDULE,
            data={
                "hook_id": hook.id,
                "trigger_id": trigger.id,
                "cron_expression": trigger.cron_expression,
                "scheduled_for": moment.isoformat(),
            },
            project_id=hook.project_id,
            source="scheduler",
        )
        try:
            await HookService.get_instance().emit_event(event)
            logger.info("scheduled hook %r fired", hook.name)
        except Exception as exc:  # noqa: BLE001 - one hook must not stop the rest
            logger.warning("scheduled hook %r failed: %s", hook.name, exc)


_scheduler: HookScheduler | None = None


def start_hook_scheduler() -> HookScheduler:
    """Start the process-wide scheduler, creating it on first call."""
    global _scheduler
    if _scheduler is None:
        _scheduler = HookScheduler()
    _scheduler.start()
    return _scheduler


async def stop_hook_scheduler() -> None:
    """Stop the process-wide scheduler, if one was started."""
    if _scheduler is not None:
        await _scheduler.stop()
