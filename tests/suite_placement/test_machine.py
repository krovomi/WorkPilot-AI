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
    # Killed below once counted: it only has to outlive the wait on a slow runner.
    entry.write_text("import time\ntime.sleep(600)\n", encoding="utf-8")
    monkeypatch.setattr(machine_module, "_BACKEND_DIR", fake_backend.resolve())
    before = machine_module.count_builds()
    child = subprocess.Popen([sys.executable, str(entry), "--spec", "002"])
    began = time.monotonic()
    try:
        for _ in range(50):
            if machine_module.count_builds() == before + 1:
                break
            subprocess.run(
                [sys.executable, "-c", "import time; time.sleep(0.05)"], check=True
            )
        waited = time.monotonic() - began
        assert machine_module.count_builds() == before + 1, (
            f"after {waited:.1f} s, child exit code {child.poll()}\n"
            f"{_seen(child.pid)}\n{_what_runs(entry)}"
        )
    finally:
        child.kill()
        child.wait()


def _seen(pid: int) -> str:
    """What count_builds saw of the child and its own children, for the message."""
    import psutil

    lines = [f"backend dir: {machine_module._BACKEND_DIR}"]
    try:
        root = psutil.Process(pid)
        tree = [root, *root.children(recursive=True)]
    except psutil.Error as error:
        return f"child {pid} is gone: {error!r}"
    for process in tree:
        try:
            cmdline = process.cmdline()
        except psutil.Error as error:
            lines.append(f"{process.pid}: cmdline refused: {error!r}")
            continue
        resolved = []
        for arg in cmdline[1:3]:
            try:
                resolved.append(str(Path(arg).resolve()))
            except OSError as error:
                resolved.append(repr(error))
        build = machine_module._is_build(cmdline)
        lines.append(f"{process.pid}: {cmdline} -> {resolved}, build={build}")
    return "\n".join(lines)


def _what_runs(entry: Path) -> str:
    """The command lines that name the entry point, to say why none was counted."""
    import psutil

    seen = []
    for process in psutil.process_iter(["pid", "ppid", "cmdline"]):
        cmdline = process.info.get("cmdline") or []
        if any(entry.name in str(arg) for arg in cmdline):
            seen.append(f"{process.info['pid']}<{process.info['ppid']}: {cmdline}")
    return f"backend dir {machine_module._BACKEND_DIR}; seen: {seen}"


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
