"""Tests for the loop that makes `TriggerType.SCHEDULE` fire.

Before this existed a hook could carry a cron expression that nothing ever
evaluated. The tests below pin the three things that make the loop trustworthy
rather than merely present: it fires what is due, it fires it exactly once, and
one malformed expression does not take the others down with it.
"""

from __future__ import annotations

import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend"))

from services.hooks.models import (  # noqa: E402
    Hook,
    HookStatus,
    Trigger,
    TriggerType,
)
from services.hooks.scheduler import HookScheduler  # noqa: E402


def _hook(cron: str | None, *, status: HookStatus = HookStatus.ACTIVE) -> Hook:
    return Hook(
        name=f"hook-{cron}",
        status=status,
        triggers=[Trigger(type=TriggerType.SCHEDULE, cron_expression=cron)],
    )


class _FakeService:
    """Stands in for the HookService singleton."""

    def __init__(self, hooks: list[Hook]) -> None:
        self._all = hooks
        self.emitted: list[object] = []

    def active_hooks(self) -> list[Hook]:
        return [h for h in self._all if h.status == HookStatus.ACTIVE]

    async def emit_event(self, event):
        self.emitted.append(event)
        return []


@pytest.fixture
def patched(monkeypatch):
    """Install a fake HookService and hand the test a factory for it."""

    def install(hooks: list[Hook]) -> _FakeService:
        service = _FakeService(hooks)
        import services.hooks.hook_service as hs

        monkeypatch.setattr(
            hs.HookService, "get_instance", classmethod(lambda cls: service)
        )
        return service

    return install


# 09:00 UTC on a Wednesday.
NINE_AM = datetime(2026, 8, 26, 9, 0, tzinfo=timezone.utc)


class TestDueSelection:
    @pytest.mark.asyncio
    async def test_a_matching_cron_fires(self, patched):
        service = patched([_hook("0 9 * * *")])
        fired = await HookScheduler().tick(NINE_AM)
        assert fired == 1
        assert len(service.emitted) == 1
        assert service.emitted[0].type is TriggerType.SCHEDULE

    @pytest.mark.asyncio
    async def test_a_non_matching_cron_does_not(self, patched):
        service = patched([_hook("0 10 * * *")])
        assert await HookScheduler().tick(NINE_AM) == 0
        assert service.emitted == []

    @pytest.mark.asyncio
    async def test_a_paused_hook_is_skipped(self, patched):
        service = patched([_hook("0 9 * * *", status=HookStatus.PAUSED)])
        assert await HookScheduler().tick(NINE_AM) == 0
        assert service.emitted == []

    @pytest.mark.asyncio
    async def test_a_schedule_trigger_with_no_expression_never_fires(self, patched):
        """An unfinished hook is not an every-minute hook."""
        service = patched([_hook(None), _hook("   ")])
        assert await HookScheduler().tick(NINE_AM) == 0
        assert service.emitted == []

    @pytest.mark.asyncio
    async def test_non_schedule_triggers_are_ignored(self, patched):
        hook = Hook(
            name="on-merge",
            status=HookStatus.ACTIVE,
            triggers=[Trigger(type=TriggerType.PR_MERGED, cron_expression="0 9 * * *")],
        )
        service = patched([hook])
        assert await HookScheduler().tick(NINE_AM) == 0
        assert service.emitted == []


class TestFiresExactlyOnce:
    @pytest.mark.asyncio
    async def test_two_polls_in_the_same_minute_fire_once(self, patched):
        """The loop polls every 60s; two polls can land in one cron minute."""
        service = patched([_hook("0 9 * * *")])
        scheduler = HookScheduler()
        assert await scheduler.tick(NINE_AM) == 1
        assert await scheduler.tick(NINE_AM.replace(second=45)) == 0
        assert len(service.emitted) == 1

    @pytest.mark.asyncio
    async def test_the_next_day_fires_again(self, patched):
        service = patched([_hook("0 9 * * *")])
        scheduler = HookScheduler()
        await scheduler.tick(NINE_AM)
        await scheduler.tick(NINE_AM.replace(day=27))
        assert len(service.emitted) == 2


class TestRobustness:
    @pytest.mark.asyncio
    async def test_one_bad_expression_does_not_stop_the_others(self, patched):
        service = patched([_hook("not a cron"), _hook("0 9 * * *")])
        assert await HookScheduler().tick(NINE_AM) == 1
        assert len(service.emitted) == 1

    @pytest.mark.asyncio
    async def test_a_failing_hook_does_not_raise(self, patched):
        service = patched([_hook("0 9 * * *")])

        async def boom(_event):
            raise RuntimeError("hook exploded")

        service.emit_event = boom
        # The tick still completes; the failure is logged, not propagated.
        assert await HookScheduler().tick(NINE_AM) == 1

    @pytest.mark.asyncio
    async def test_the_event_carries_what_fired_it(self, patched):
        service = patched([_hook("0 9 * * *")])
        await HookScheduler().tick(NINE_AM)
        data = service.emitted[0].data
        assert data["cron_expression"] == "0 9 * * *"
        assert data["scheduled_for"] == NINE_AM.isoformat()
        assert service.emitted[0].source == "scheduler"
