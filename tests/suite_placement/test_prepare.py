"""`test_placement.prepare`: decide, wait in the queue, write the decision."""

from __future__ import annotations

import json
import os
import time

import pytest
from test_placement import prepare as prepare_module
from test_placement.decide import GIB, Machine
from test_placement.prepare import DECISION_FILE, prepare
from test_placement.queue import Ticket

BUSY = Machine(cores=8, cpu_busy=95.0, ram_total=16 * GIB, ram_free=1 * GIB, builds=3)
ROOMY = Machine(cores=16, cpu_busy=5.0, ram_total=32 * GIB, ram_free=28 * GIB, builds=3)


class Paused(Exception):
    pass


def _decision(spec_dir):
    return json.loads((spec_dir / DECISION_FILE).read_text(encoding="utf-8"))


@pytest.fixture
def dirs(tmp_path):
    project, spec = tmp_path / "project", tmp_path / "spec"
    project.mkdir()
    spec.mkdir()
    return project, spec


async def _no_sleep(_seconds):
    return None


async def test_the_machine_chosen_is_not_measured(dirs):
    project, spec = dirs

    def sampler(_suites):
        raise AssertionError("not measured")

    placement = await prepare(
        project,
        spec,
        has_pr=False,
        env={"WORKPILOT_TEST_PLACEMENT": "machine"},
        sampler=sampler,
    )
    assert placement.runs_here and placement.prompt_addendum() == ""
    assert _decision(spec)["reason"] == "chosen"
    assert placement.ticket is not None and placement.ticket.state == "running"
    placement.close()


async def test_a_busy_machine_with_a_pr_sends_the_suite_to_the_ci(dirs):
    project, spec = dirs
    placement = await prepare(
        project,
        spec,
        has_pr=True,
        env={"WORKPILOT_TEST_PLACEMENT_ROUTES": "ci"},
        sampler=lambda _suites: BUSY,
    )
    assert (placement.decision.target, placement.decision.reason) == ("ci", "pr")
    addendum = placement.prompt_addendum()
    assert "Do NOT run the whole test suite" in addendum
    assert "pull request exists" in addendum
    assert '"deferred to ci"' in addendum
    written = _decision(spec)
    assert written["target"] == "ci" and written["decidedBy"] == "default"
    assert written["short"] == ["cpu", "ram"]
    assert placement.ticket is not None and placement.ticket.path is None
    with placement.measure():
        pass
    assert placement.close() is None


async def test_the_server_is_offered_only_when_the_app_follows_it(dirs):
    project, spec = dirs
    env = {"WORKPILOT_TEST_PLACEMENT_ROUTES": "server"}
    placement = await prepare(
        project,
        spec,
        has_pr=False,
        server=True,
        env=env,
        sampler=lambda _s: BUSY,
        ticket=Ticket(root=spec / "q"),
        sleep=_no_sleep,
    )
    assert placement.decision.target == "server"
    assert "WorkPilot server" in placement.prompt_addendum()


async def test_without_a_route_the_suite_waits_for_room(dirs):
    project, spec = dirs
    readings = iter([BUSY, BUSY, ROOMY])
    waits, sleeps = [], []

    async def sleep(seconds):
        sleeps.append(seconds)

    queue = spec / "queue"
    blocker = queue / f"{0:020d}-1.json"
    queue.mkdir()
    blocker.write_text(
        json.dumps({"pid": os.getppid(), "state": "running"}), encoding="utf-8"
    )
    placement = await prepare(
        project,
        spec,
        has_pr=False,
        env={},
        sampler=lambda _s: next(readings),
        sleep=sleep,
        on_wait=waits.append,
        ticket=Ticket(root=queue),
        poll_seconds=7,
    )
    assert (placement.decision.target, placement.decision.reason) == ("machine", "room")
    assert len(waits) == 2 and sleeps == [7, 7]
    assert _decision(spec)["target"] == "machine"
    placement.close()
    assert [path.name for path in queue.iterdir()] == [blocker.name]


async def test_alone_in_the_queue_its_turn_comes_on_a_busy_machine(dirs):
    project, spec = dirs
    placement = await prepare(
        project,
        spec,
        has_pr=False,
        env={},
        sampler=lambda _s: BUSY,
        ticket=Ticket(root=spec / "queue"),
        sleep=_no_sleep,
    )
    assert (placement.decision.target, placement.decision.reason) == ("machine", "turn")
    placement.close()


async def test_a_pause_while_waiting_frees_the_ticket(dirs):
    project, spec = dirs
    queue = spec / "queue"
    queue.mkdir()
    (queue / f"{0:020d}-1.json").write_text(
        json.dumps({"pid": os.getppid(), "state": "running"}), encoding="utf-8"
    )
    ticket = Ticket(root=queue)

    def pause():
        raise Paused

    with pytest.raises(Paused):
        await prepare(
            project,
            spec,
            has_pr=False,
            env={},
            sampler=lambda _s: BUSY,
            check_pause=pause,
            ticket=ticket,
            sleep=_no_sleep,
        )
    assert ticket.path is None
    assert _decision(spec)["target"] == "queue"


async def test_a_session_run_here_is_recorded_in_the_history(dirs, monkeypatch):
    project, spec = dirs
    monkeypatch.setattr(prepare_module.Meter, "__init__", _quick_meter)
    placement = await prepare(
        project, spec, has_pr=False, env={}, sampler=lambda _s: ROOMY
    )
    with placement.measure():
        # Long enough for Windows' clock (15.6 ms ticks): an empty block can
        # last 0 s there, and a session of 0 s is not recorded.
        time.sleep(0.05)
    usage = placement.close()
    assert usage is not None
    history = project / ".workpilot" / "test-placement" / "history.json"
    assert len(json.loads(history.read_text(encoding="utf-8"))["runs"]) == 1


_real_init = prepare_module.Meter.__init__


def _quick_meter(self, interval=0.05, gpu=False):
    _real_init(self, interval=interval, gpu=gpu)


async def test_an_unwritable_decision_is_only_logged(dirs, caplog):
    project, spec = dirs
    (spec / DECISION_FILE).mkdir()
    placement = await prepare(
        project, spec, has_pr=False, env={"WORKPILOT_TEST_PLACEMENT": "machine"}
    )
    assert placement.runs_here
    assert "could not write" in caplog.text
    placement.close()
