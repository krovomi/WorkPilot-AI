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
from pathlib import Path

import pytest
from agents.swarm.types import SubtaskNode, SubtaskState, SwarmConfig, Wave
from agents.swarm.wave_executor import (
    SWARM_EVENT_PREFIX,
    SubtaskResult,
    WaveExecutor,
    emit_swarm_event,
)

RUN_PY = r"""
import json, os, sys, time
from pathlib import Path

subtask = sys.argv[sys.argv.index("--subtask") + 1]
spec = sys.argv[sys.argv.index("--spec") + 1]
attempts = Path("attempts")
attempts.mkdir(exist_ok=True)
counter = attempts / subtask
attempt = int(counter.read_text(encoding="utf-8")) if counter.exists() else 0
counter.write_text(str(attempt + 1), encoding="utf-8")
plan = json.loads(Path("swarm_plan.json").read_text(encoding="utf-8"))
steps = plan[subtask]
step = steps[min(attempt, len(steps) - 1)]
seen = {
    "spec": spec,
    "mode": os.environ.get("SWARM_MODE"),
    "subtask": os.environ.get("SWARM_SUBTASK_ID"),
    "wave": os.environ.get("SWARM_WAVE_INDEX"),
}
(attempts / (subtask + ".env.json")).write_text(json.dumps(seen), encoding="utf-8")
if step == "ok":
    print("working on " + subtask, flush=True)
    print('__EXEC_PHASE__:{"phase": "coding"}', flush=True)
    sys.exit(0)
if step == "fail":
    # More than a pipe buffer on stderr: the executor must keep reading it.
    sys.stderr.write("E" * 100_000)
    sys.exit(1)
if step == "silent":
    sys.exit(3)
if step == "long":
    # One event longer than a pipe buffer, then a last line with no line end.
    print('__TASK_EVENT__:{"diff": "' + "d" * 100_000 + '"}', flush=True)
    sys.stdout.write("last words")
    sys.exit(0)
if step == "hang":
    print("started", flush=True)
    time.sleep(60)
"""


def _events(out: str) -> list[dict]:
    return [
        json.loads(line[len(SWARM_EVENT_PREFIX) :])
        for line in out.splitlines()
        if line.startswith(SWARM_EVENT_PREFIX)
    ]


@pytest.fixture
def world(tmp_path: Path) -> dict[str, Path]:
    source = tmp_path / "backend"
    source.mkdir()
    (source / "run.py").write_text(RUN_PY, encoding="utf-8")
    project = tmp_path / "project"
    spec = project / ".workpilot" / "specs" / "002-cart"
    spec.mkdir(parents=True)
    return {"source": source, "project": project, "spec": spec}


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
    # The error is the start of stderr, read to the end without blocking.
    assert by_id["s2"].error == "E" * 500
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
    assert sorted(seen["failed"]) == [("s2", "E" * 500), ("s3", "Exit code 3")]
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
    # Only the phase markers of a subtask are forwarded, not its plain output.
    [forwarded] = [e for e in events if e["type"] == "subtask_log"]
    assert forwarded == {
        "type": "subtask_log",
        "subtask_id": "s1",
        "line": '__EXEC_PHASE__:{"phase": "coding"}',
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
    assert len(forwarded["line"]) == len(lines[0])


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
    assert all(r.error and r.error.startswith("Exit code -") for r in result.results)


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
