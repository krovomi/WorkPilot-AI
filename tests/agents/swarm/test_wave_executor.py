"""A wave of subtasks, each run as its own Python process.

The executor starts ``<source>/run.py --spec <spec> --subtask <id>`` for every
subtask of the wave and reads its output. ``source_path`` points here at a
backend stand-in whose ``run.py`` does what ``swarm_plan.json`` (in the project,
the process's working directory) says for that subtask and attempt: the
processes, pipes, exit codes, timeouts and kills are real.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import pytest
from agents.swarm.types import SubtaskNode, SubtaskState, SwarmConfig, Wave
from agents.swarm.wave_executor import (
    SWARM_EVENT_PREFIX,
    SubtaskResult,
    WaveExecutor,
    emit_swarm_event,
)
from foundation.platform import is_windows


def _events(out: str) -> list[dict]:
    return [
        json.loads(line[len(SWARM_EVENT_PREFIX) :])
        for line in out.splitlines()
        if line.startswith(SWARM_EVENT_PREFIX)
    ]


def _executor(world: dict[str, Path], timeout: float = 60.0) -> WaveExecutor:
    return WaveExecutor(
        project_dir=world["project"],
        spec_dir=world["spec"],
        config=SwarmConfig(subtask_timeout_seconds=timeout),
        python_path=sys.executable,
        source_path=str(world["source"]),
    )


def _plan(world: dict[str, Path], **steps: list[str]) -> None:
    (world["project"] / "swarm_plan.json").write_text(
        json.dumps(steps), encoding="utf-8"
    )


def _nodes(*ids: str, wave: int = 0) -> dict[str, SubtaskNode]:
    return {
        i: SubtaskNode(id=i, phase_name="p", description=f"do {i}", wave_index=wave)
        for i in ids
    }


@pytest.mark.asyncio
async def test_a_wave_runs_every_subtask_and_reports_each(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _plan(world, s1=["ok"], s2=["fail"], s3=["silent"])
    nodes = _nodes("s1", "s2", "s3", wave=1)
    wave = Wave(index=1, subtask_ids=["s1", "s2", "s3", "gone"])
    seen: dict[str, list] = {"started": [], "completed": [], "failed": [], "log": []}

    result = await _executor(world).execute_wave(
        wave,
        nodes,
        on_subtask_started=lambda sid: seen["started"].append(sid),
        on_subtask_completed=lambda sid, r: seen["completed"].append(sid),
        on_subtask_failed=lambda sid, err: seen["failed"].append((sid, err)),
        on_subtask_log=lambda sid, line: seen["log"].append((sid, line)),
    )

    by_id = {r.subtask_id: r for r in result.results}
    # "gone" is not in the plan's nodes: it is not run.
    assert sorted(by_id) == ["s1", "s2", "s3"]
    assert by_id["s1"].success and by_id["s1"].error is None
    # The error is the end of stderr, read to the end without blocking.
    s2_error = by_id["s2"].error or ""
    assert len(s2_error) == 500
    assert s2_error.endswith("E\nboom: the real error")
    assert by_id["s3"].error == "Exit code 3"
    assert not result.all_succeeded
    assert wave.state is SubtaskState.FAILED
    assert result.duration_seconds >= 0
    assert [nodes[i].state for i in ("s1", "s2", "s3")] == [
        SubtaskState.COMPLETED,
        SubtaskState.FAILED,
        SubtaskState.FAILED,
    ]
    assert nodes["s3"].error == "Exit code 3"
    assert all(n.process_pid is None for n in nodes.values())
    assert sorted(seen["started"]) == ["s1", "s2", "s3"]
    assert seen["completed"] == ["s1"]
    assert sorted(seen["failed"]) == [("s2", s2_error), ("s3", "Exit code 3")]
    assert ("s1", "working on s1") in seen["log"]
    # Each process was told which subtask it is, in which wave, of which spec.
    env = json.loads(
        (world["project"] / "attempts" / "s1.env.json").read_text(encoding="utf-8")
    )
    assert env == {"spec": "002-cart", "mode": "1", "subtask": "s1", "wave": "1"}

    events = _events(capsys.readouterr().out)
    kinds = [e["type"] for e in events]
    assert kinds[0] == "wave_started"
    assert events[0]["parallelism"] == 4
    assert kinds.count("subtask_started") == 3
    assert kinds.count("subtask_completed") == 3
    # Only the phase markers of a subtask are forwarded, not its plain output,
    # and without the marker: the app would take them for the task's own.
    [forwarded] = [e for e in events if e["type"] == "subtask_log"]
    assert forwarded == {
        "type": "subtask_log",
        "subtask_id": "s1",
        "kind": "phase",
        "data": '{"phase": "coding"}',
    }
    assert events[-1] == {
        "type": "wave_completed",
        "wave_index": 1,
        "all_succeeded": False,
        "duration_seconds": events[-1]["duration_seconds"],
        "completed": 1,
        "failed": 2,
    }


@pytest.mark.asyncio
async def test_a_wave_whose_subtasks_all_succeed_is_completed(
    world: dict[str, Path],
) -> None:
    _plan(world, a=["ok"], b=["ok"])
    wave = Wave(index=0, subtask_ids=["a", "b"])

    result = await _executor(world).execute_wave(wave, _nodes("a", "b"))

    assert result.all_succeeded
    assert wave.state is SubtaskState.COMPLETED


@pytest.mark.asyncio
async def test_long_lines_and_a_last_line_without_its_end_are_read_whole(
    world: dict[str, Path], capsys: pytest.CaptureFixture[str]
) -> None:
    _plan(world, big=["long"])
    lines: list[str] = []

    result = await _executor(world).execute_wave(
        Wave(index=0, subtask_ids=["big"]),
        _nodes("big"),
        on_subtask_log=lambda _sid, line: lines.append(line),
    )

    assert result.all_succeeded
    assert lines == ['__TASK_EVENT__:{"diff": "' + "d" * 100_000 + '"}', "last words"]
    [forwarded] = [
        e for e in _events(capsys.readouterr().out) if e["type"] == "subtask_log"
    ]
    assert forwarded["kind"] == "task"
    assert forwarded["data"] == '{"diff": "' + "d" * 100_000 + '"}'
    assert "__TASK_EVENT__" not in forwarded["data"]


@pytest.mark.asyncio
async def test_a_subtask_past_its_timeout_is_killed(world: dict[str, Path]) -> None:
    _plan(world, slow=["hang"])
    nodes = _nodes("slow")
    failures: list[tuple] = []

    result = await _executor(world, timeout=0.5).execute_wave(
        Wave(index=0, subtask_ids=["slow"]),
        nodes,
        on_subtask_failed=lambda sid, err: failures.append((sid, err)),
    )

    [only] = result.results
    assert not only.success
    assert only.error == "Subtask slow timed out after 0.5s and was killed"
    assert nodes["slow"].state is SubtaskState.FAILED
    assert nodes["slow"].error == only.error
    assert failures == [("slow", only.error)]


@pytest.mark.asyncio
async def test_a_subtask_whose_start_fails_is_reported_failed(
    world: dict[str, Path],
) -> None:
    _plan(world, a=["ok"], b=["ok"])

    def started(subtask_id: str) -> None:
        if subtask_id == "b":
            raise RuntimeError("board is gone")

    result = await _executor(world).execute_wave(
        Wave(index=0, subtask_ids=["a", "b"]),
        _nodes("a", "b"),
        on_subtask_started=started,
    )

    assert [(r.subtask_id, r.success, r.error) for r in result.results] == [
        ("a", True, None),
        ("b", False, "board is gone"),
    ]
    assert not result.all_succeeded


@pytest.mark.asyncio
async def test_cancelling_kills_the_running_subtasks(world: dict[str, Path]) -> None:
    _plan(world, one=["hang"], two=["hang"])
    executor = _executor(world)
    nodes = _nodes("one", "two")
    run = asyncio.create_task(
        executor.execute_wave(Wave(index=0, subtask_ids=["one", "two"]), nodes)
    )
    for _ in range(200):
        if len(executor._running_processes) == 2:
            break
        await asyncio.sleep(0.05)
    assert nodes["one"].process_pid is not None

    assert await executor.cancel_subtask("one") is True
    assert await executor.cancel_subtask("never-started") is False
    await executor.cancel_all()
    result = await asyncio.wait_for(run, timeout=30)

    assert executor._running_processes == {}
    assert [(r.subtask_id, r.success) for r in result.results] == [
        ("one", False),
        ("two", False),
    ]
    # A killed process exits on SIGKILL on POSIX; Windows' TerminateProcess
    # leaves exit code 1.
    killed = "Exit code 1" if is_windows() else "Exit code -9"
    assert all(r.error and r.error.startswith(killed) for r in result.results)


@pytest.mark.asyncio
async def test_a_subtask_cancelled_then_swept_reports_its_kill(
    world: dict[str, Path],
) -> None:
    _plan(world, one=["hang"])
    executor = _executor(world)
    run = asyncio.create_task(
        executor.execute_wave(Wave(index=0, subtask_ids=["one"]), _nodes("one"))
    )
    for _ in range(200):
        if executor._running_processes:
            break
        await asyncio.sleep(0.05)

    assert await executor.cancel_subtask("one") is True
    # The child dies before the loop runs again; sweeping the wave then must
    # not touch it, or its exit is reaped where the loop cannot see it.
    time.sleep(0.5)
    await executor.cancel_all()
    result = await asyncio.wait_for(run, timeout=30)

    killed = "Exit code 1" if is_windows() else "Exit code -9"
    [only] = result.results
    assert only.error and only.error.startswith(killed)


@pytest.mark.asyncio
async def test_a_process_that_already_exited_is_not_an_error_to_cancel(
    world: dict[str, Path],
) -> None:
    executor = _executor(world)
    process = await asyncio.create_subprocess_exec(sys.executable, "-c", "pass")
    await process.wait()
    # It exited between being listed as running and being killed.
    executor._running_processes["late"] = process

    assert await executor.cancel_subtask("late") is False
    await executor.cancel_all()
    assert executor._running_processes == {}


def test_an_event_is_dropped_when_stdout_is_gone(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _Closed:
        def write(self, _text: str) -> int:
            raise OSError("stdout closed")

        def flush(self) -> None:
            raise OSError("stdout closed")

    monkeypatch.setattr(sys, "stdout", _Closed())

    emit_swarm_event("wave_started", {"wave_index": 0})


def test_a_result_defaults_to_no_error() -> None:
    assert SubtaskResult("s", True) == SubtaskResult(
        subtask_id="s", success=True, duration_seconds=0.0, error=None
    )


async def test_a_worker_error_reads_the_same_on_every_os(
    world: dict[str, Path],
) -> None:
    _plan(world, s1=["crlf"])
    nodes = _nodes("s1", wave=1)

    result = await _executor(world).execute_wave(
        Wave(index=1, subtask_ids=["s1"]), nodes
    )

    [failed] = result.results
    assert failed.error == "Traceback\nboom: the real error\n"
