"""`test_placement.machine`: cores, memory, GPUs and the other builds."""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from test_placement import machine as machine_module
from test_placement.decide import MIB

BACKEND = Path(machine_module.__file__).resolve().parents[1]


def test_a_sample_reads_this_machine(monkeypatch):
    monkeypatch.setattr(machine_module, "read_gpus", lambda: ())
    machine = machine_module.sample(suites=2, cpu_interval=0.05)
    assert machine.cores >= 1
    assert 0.0 <= machine.cpu_busy <= 100.0
    assert 0 < machine.ram_free <= machine.ram_total
    assert machine.suites == 2
    assert machine.builds >= 0


def test_only_this_installs_run_py_is_a_build(tmp_path):
    assert machine_module._is_build(
        ["python", str(BACKEND / "run.py"), "--spec", "001"]
    )
    assert machine_module._is_build(["python", "-u", str(BACKEND / "run.py")])
    assert not machine_module._is_build(["python", str(tmp_path / "run.py")])
    assert not machine_module._is_build(["python", str(BACKEND / "provider_api.py")])
    assert not machine_module._is_build(["python"])


def test_another_build_is_counted_but_not_this_one(monkeypatch, tmp_path):
    fake_backend = tmp_path / "backend"
    fake_backend.mkdir()
    entry = fake_backend / "run.py"
    # Killed below: it only has to outlive the wait, however slow the machine.
    entry.write_text("import time\ntime.sleep(600)\n", encoding="utf-8")
    monkeypatch.setattr(machine_module, "_BACKEND_DIR", fake_backend.resolve())
    before = machine_module.count_builds()
    child = subprocess.Popen([sys.executable, str(entry), "--spec", "002"])
    started = time.monotonic()
    try:
        while time.monotonic() - started < 60:
            if machine_module.count_builds() == before + 1:
                break
            subprocess.run(
                [sys.executable, "-c", "import time; time.sleep(0.05)"], check=True
            )
        assert machine_module.count_builds() == before + 1, _what_runs(
            entry, child, time.monotonic() - started
        )
    finally:
        child.kill()
        child.wait()


def _what_runs(entry: Path, child: subprocess.Popen, waited: float) -> str:
    """What psutil saw of the build, to say why it was not counted."""
    import psutil

    seen = []
    for process in psutil.process_iter(["pid", "ppid", "cmdline"]):
        cmdline = process.info.get("cmdline") or []
        if any(entry.name in str(arg) for arg in cmdline):
            seen.append(f"{process.info['pid']}<{process.info['ppid']}: {cmdline}")
    try:
        direct = psutil.Process(child.pid)
        own = f"{direct.cmdline()}, children {[c.cmdline() for c in direct.children()]}"
    except psutil.Error as error:
        own = repr(error)
    return (
        f"after {waited:.1f} s, exit code {child.poll()}, backend dir "
        f"{machine_module._BACKEND_DIR}; the child: {own}; seen: {seen}"
    )


def _smi(monkeypatch, stdout: str, returncode: int = 0) -> None:
    monkeypatch.setattr(
        machine_module, "find_executable", lambda _name: "/opt/nvidia-smi"
    )

    def run(args, **_kwargs):
        assert args[0] == "/opt/nvidia-smi"
        return subprocess.CompletedProcess(args, returncode, stdout, "")

    monkeypatch.setattr(machine_module.subprocess, "run", run)


def test_gpus_are_read_from_nvidia_smi(monkeypatch):
    _smi(monkeypatch, "NVIDIA RTX 4090, 24564, 1024, 37\nbroken line\nX, n/a, 3, 4\n")
    (gpu,) = machine_module.read_gpus()
    assert gpu.name == "NVIDIA RTX 4090"
    assert gpu.vram_total == 24564 * MIB
    assert gpu.vram_free == (24564 - 1024) * MIB
    assert gpu.busy == 37.0


def test_no_gpu_tool_or_a_failing_one_means_no_gpu(monkeypatch):
    monkeypatch.setattr(machine_module, "find_executable", lambda _name: None)
    assert machine_module.read_gpus() == ()
    _smi(monkeypatch, "", returncode=9)
    assert machine_module.read_gpus() == ()

    def boom(*_args, **_kwargs):
        raise OSError("no driver")

    monkeypatch.setattr(machine_module.subprocess, "run", boom)
    assert machine_module.read_gpus() == ()


def test_a_utilisation_the_tool_does_not_give_is_none(monkeypatch):
    _smi(monkeypatch, "GPU, 8000, 10, [N/A]\n")
    (gpu,) = machine_module.read_gpus()
    assert gpu.busy is None
