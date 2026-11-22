"""`test_placement.demand`: the suite's measured cost, shared by the project's tasks."""

from __future__ import annotations

import json
import subprocess
import sys

from test_placement import demand as demand_module
from test_placement.decide import Demand
from test_placement.demand import Meter, Usage, demand, history_path, record


def test_history_lives_in_the_main_project_even_from_a_worktree(tmp_path):
    worktree = tmp_path / ".workpilot" / "worktrees" / "tasks" / "001-x"
    assert (
        history_path(worktree)
        == tmp_path / ".workpilot" / "test-placement" / "history.json"
    )
    assert (
        history_path(tmp_path)
        == tmp_path / ".workpilot" / "test-placement" / "history.json"
    )


def test_without_history_the_defaults(tmp_path):
    assert demand(tmp_path) == Demand()


def test_the_median_of_the_last_runs(tmp_path):
    for cores, ram in ((1.0, 100), (3.0, 300), (2.0, 200)):
        record(tmp_path, Usage(cores=cores, ram=ram, vram=0, seconds=10))
    need = demand(tmp_path)
    assert (need.cores, need.ram, need.vram, need.runs) == (2.0, 200, 0, 3)


def test_a_tiny_suite_still_counts_half_a_core(tmp_path):
    record(tmp_path, Usage(cores=0.0, ram=0, vram=0, seconds=1))
    assert demand(tmp_path).cores == 0.5


def test_history_is_bounded_and_skips_nonsense(tmp_path):
    for index in range(demand_module.HISTORY_LIMIT + 5):
        record(tmp_path, Usage(cores=1.0, ram=index, vram=0, seconds=1))
    runs = json.loads(history_path(tmp_path).read_text(encoding="utf-8"))["runs"]
    assert len(runs) == demand_module.HISTORY_LIMIT
    path = history_path(tmp_path)
    path.write_text(
        json.dumps(
            {
                "runs": [
                    {"cores": "x", "ram": 1},
                    {"cores": True, "ram": 1},
                    3,
                    {"cores": -1, "ram": 5},
                ]
            }
        ),
        encoding="utf-8",
    )
    assert demand(tmp_path) == Demand()
    path.write_text("{broken", encoding="utf-8")
    assert demand(tmp_path) == Demand()


def test_a_history_that_cannot_be_written_is_only_logged(tmp_path, caplog):
    (tmp_path / ".workpilot").write_text("a file, not a folder", encoding="utf-8")
    record(tmp_path, Usage(cores=1.0, ram=1, vram=0, seconds=1))
    assert "could not write" in caplog.text


def test_the_meter_sees_a_child_working_and_takes_the_base_off(monkeypatch):
    monkeypatch.setattr(demand_module, "_gpu_memory_by_pid", lambda: {})
    script = "import time\nblock = bytearray(64 * 1024 * 1024)\nend = time.time() + 1.5\nwhile time.time() < end: pass\n"
    with Meter(interval=0.2) as meter:
        subprocess.run([sys.executable, "-c", script], check=True)
    usage = meter.usage
    assert usage is not None
    assert usage.seconds >= 1.5
    assert usage.ram >= 32 * 1024 * 1024
    assert usage.cores > 0.2


def test_the_meter_reads_the_vram_of_its_children_only(monkeypatch):
    seen = {}

    def fake_vram():
        return dict.fromkeys(seen.get("pids", []), 512 * 1024 * 1024) | {1: 10**12}

    monkeypatch.setattr(demand_module, "_gpu_memory_by_pid", fake_vram)
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(1.2)"])
    try:
        with Meter(interval=0.2) as meter:
            seen["pids"] = [child.pid]
            child.wait()
    finally:
        child.kill()
    assert meter.usage is not None and meter.usage.vram == 512 * 1024 * 1024


def test_gpu_memory_by_pid_parses_nvidia_smi(monkeypatch):
    monkeypatch.setattr(
        demand_module, "find_executable", lambda _name: "/usr/bin/nvidia-smi"
    )

    def run(args, **_kwargs):
        assert (
            args[0] == "/usr/bin/nvidia-smi"
            and "--query-compute-apps=pid,used_memory" in args
        )
        return subprocess.CompletedProcess(args, 0, "123, 100\nbad\n7,x\n", "")

    monkeypatch.setattr(demand_module.subprocess, "run", run)
    assert demand_module._gpu_memory_by_pid() == {123: 100 * 1024 * 1024}


def test_gpu_memory_without_the_tool_is_empty(monkeypatch):
    monkeypatch.setattr(demand_module, "find_executable", lambda _name: None)
    assert demand_module._gpu_memory_by_pid() == {}
    monkeypatch.setattr(demand_module, "find_executable", lambda _name: "smi")

    def boom(*_args, **_kwargs):
        raise subprocess.TimeoutExpired("smi", 5)

    monkeypatch.setattr(demand_module.subprocess, "run", boom)
    assert demand_module._gpu_memory_by_pid() == {}
