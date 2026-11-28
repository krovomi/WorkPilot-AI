"""The scheduler's own life: started once, polling, stopped, never in server mode.

`tests/test_hook_scheduler.py` pins which hooks one tick fires; these tests
pin the loop around it.
"""

from __future__ import annotations

import asyncio

import pytest
from services.hooks import scheduler as sched
from services.hooks.scheduler import HookScheduler


async def _until(condition, rounds: int = 200) -> None:
    for _ in range(rounds):
        if condition():
            return
        await asyncio.sleep(0)
    raise AssertionError("condition never held")


def test_start_is_idempotent_and_stop_unwinds_the_loop(monkeypatch):
    ticks = []

    async def tick(self, now=None):
        ticks.append(now)
        return 0

    monkeypatch.setattr(HookScheduler, "tick", tick)

    async def scenario():
        scheduler = HookScheduler(poll_seconds=0)
        await scheduler.stop()  # nothing started: nothing to stop

        scheduler.start()
        task = scheduler._task
        scheduler.start()
        assert scheduler._task is task

        await _until(lambda: len(ticks) >= 2)
        await scheduler.stop()
        assert scheduler._task is None
        assert task.cancelled()

    asyncio.run(scenario())


def test_a_tick_that_fails_does_not_end_the_loop(monkeypatch, caplog):
    calls = []

    async def tick(self, now=None):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("bad hook")
        return 0

    monkeypatch.setattr(HookScheduler, "tick", tick)

    async def scenario():
        scheduler = HookScheduler(poll_seconds=0)
        scheduler.start()
        await _until(lambda: len(calls) >= 2)
        await scheduler.stop()

    asyncio.run(scenario())

    assert "hook scheduler tick failed: bad hook" in caplog.text


def test_a_cancelled_tick_ends_the_loop(monkeypatch):
    async def tick(self, now=None):
        raise asyncio.CancelledError

    monkeypatch.setattr(HookScheduler, "tick", tick)

    async def scenario():
        with pytest.raises(asyncio.CancelledError):
            await HookScheduler(poll_seconds=0)._run()

    asyncio.run(scenario())


def test_the_process_scheduler_starts_once_and_stops(monkeypatch):
    import foundation.api_safety as api_safety

    monkeypatch.setattr(api_safety, "server_mode_roots", lambda: None)
    monkeypatch.setattr(sched, "_scheduler", None)
    monkeypatch.setattr(HookScheduler, "tick", lambda self, now=None: _zero())

    async def scenario():
        first = sched.start_hook_scheduler()
        assert sched.start_hook_scheduler() is first
        assert first._task is not None
        await sched.stop_hook_scheduler()
        assert first._task is None

    asyncio.run(scenario())


async def _zero() -> int:
    return 0


def test_server_mode_runs_no_schedule(monkeypatch, tmp_path):
    import foundation.api_safety as api_safety

    monkeypatch.setattr(api_safety, "server_mode_roots", lambda: [tmp_path])
    monkeypatch.setattr(sched, "_scheduler", None)

    assert sched.start_hook_scheduler() is None
    assert sched._scheduler is None


def test_stopping_a_scheduler_never_started_does_nothing(monkeypatch):
    monkeypatch.setattr(sched, "_scheduler", None)

    asyncio.run(sched.stop_hook_scheduler())
