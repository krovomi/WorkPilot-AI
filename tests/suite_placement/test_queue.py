"""`test_placement.queue`: one file per waiting or running suite of the machine."""

from __future__ import annotations

import json
import os
import subprocess
import sys

from test_placement.queue import Ticket, queue_dir


def _dead_pid() -> int:
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    return child.pid


def _foreign(root, name: str, pid: int, state: str) -> None:
    (root / name).write_text(json.dumps({"pid": pid, "state": state}), encoding="utf-8")


def test_the_queue_folder_follows_the_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("WORKPILOT_SUITE_QUEUE_DIR", str(tmp_path / "q"))
    assert queue_dir() == tmp_path / "q"
    monkeypatch.delenv("WORKPILOT_SUITE_QUEUE_DIR")
    assert queue_dir().parts[-2:] == (".workpilot", "suite-queue")


def test_a_ticket_alone_has_its_turn_and_is_removed_after(tmp_path):
    with Ticket("001-a", root=tmp_path) as ticket:
        assert ticket.path is not None and ticket.path.is_file()
        assert ticket.my_turn()
        ticket.mark_running()
        assert json.loads(ticket.path.read_text(encoding="utf-8"))["state"] == "running"
    assert list(tmp_path.iterdir()) == []


def test_an_older_waiting_ticket_goes_first(tmp_path):
    _foreign(tmp_path, f"{0:020d}-1.json", os.getppid(), "waiting")
    with Ticket(root=tmp_path) as ticket:
        assert not ticket.my_turn()
        assert ticket.others_running() == 0


def test_a_running_suite_holds_even_a_newer_one(tmp_path):
    with Ticket(root=tmp_path) as ticket:
        _foreign(tmp_path, f"{9 * 10**19:020d}-1.json", os.getppid(), "running")
        assert ticket.others_running() == 1
        assert not ticket.my_turn()


def test_a_dead_build_never_holds_the_queue(tmp_path):
    stale = tmp_path / f"{0:020d}-1.json"
    _foreign(tmp_path, stale.name, _dead_pid(), "running")
    (tmp_path / f"{1:020d}-2.json").write_text("not json", encoding="utf-8")
    _foreign(tmp_path, f"{2:020d}-3.json", os.getppid(), "lost")
    with Ticket(root=tmp_path) as ticket:
        assert ticket.my_turn()
        assert ticket.others_running() == 0
    assert not stale.exists()


def test_an_unwritable_queue_lets_the_suite_run(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("x", encoding="utf-8")
    with Ticket(root=blocker / "queue") as ticket:
        assert ticket.path is None
        assert ticket.my_turn()
        ticket.mark_running()
