"""What the machine running WorkPilot has left, read with psutil.

CPU is the whole machine's load over one second, memory what the OS calls
available. GPUs are read from ``nvidia-smi`` when it is on the PATH (NVIDIA on
Windows and Linux); without it the list is empty and VRAM is not judged, never
guessed. Other builds are this install's ``run.py`` processes, the current
build and its ancestors left out.
"""

from __future__ import annotations

import logging
import subprocess
from pathlib import Path

import psutil
from foundation.platform import find_executable

from .decide import MIB, Gpu, Machine

__all__ = ["count_builds", "read_gpus", "sample"]

logger = logging.getLogger(__name__)

_BACKEND_DIR = Path(__file__).resolve().parents[1]
_ENTRY_POINTS = ("run.py",)
_SMI_TIMEOUT_SECONDS = 5


def _own_lineage() -> set[int]:
    pids: set[int] = set()
    try:
        process: psutil.Process | None = psutil.Process()
        while process is not None:
            pids.add(process.pid)
            process = process.parent()
    except psutil.Error:
        pass
    return pids


def _is_build(cmdline: list[str]) -> bool:
    for arg in cmdline[1:3]:
        path = Path(arg)
        if path.name not in _ENTRY_POINTS:
            continue
        try:
            if path.resolve().parent == _BACKEND_DIR:
                return True
        except OSError:
            continue
    return False


def count_builds() -> int:
    """This install's builds running now, the current one not counted."""
    mine = _own_lineage()
    count = 0
    for process in psutil.process_iter(["pid", "cmdline"]):
        try:
            if process.info["pid"] in mine:
                continue
            if _is_build(process.info.get("cmdline") or []):
                count += 1
        except (psutil.Error, TypeError):
            continue
    return count


def _number(text: str) -> float | None:
    try:
        return float(text.strip())
    except ValueError:
        return None


def read_gpus() -> tuple[Gpu, ...]:
    """The NVIDIA GPUs and their VRAM, or nothing when they cannot be read."""
    smi = find_executable("nvidia-smi")
    if not smi:
        return ()
    try:
        result = subprocess.run(
            [
                smi,
                "--query-gpu=name,memory.total,memory.used,utilization.gpu",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=_SMI_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("nvidia-smi not readable: %s", exc)
        return ()
    if result.returncode != 0:
        return ()
    gpus: list[Gpu] = []
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) != 4:
            continue
        total, used = _number(parts[1]), _number(parts[2])
        if total is None or used is None:
            continue
        gpus.append(
            Gpu(
                name=parts[0][:80],
                vram_total=int(total * MIB),
                vram_used=int(used * MIB),
                busy=_number(parts[3]),
            )
        )
    return tuple(gpus)


def sample(suites: int = 0, cpu_interval: float = 1.0) -> Machine:
    """One reading of the machine, for ``decide``."""
    memory = psutil.virtual_memory()
    return Machine(
        cores=psutil.cpu_count(logical=True) or 1,
        cpu_busy=float(psutil.cpu_percent(interval=cpu_interval)),
        ram_total=int(memory.total),
        ram_free=int(memory.available),
        gpus=read_gpus(),
        builds=count_builds(),
        suites=suites,
    )
