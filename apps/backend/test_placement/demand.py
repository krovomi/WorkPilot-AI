"""What this project's suite takes, measured on the QA sessions that ran here.

``Meter`` samples the build's process tree every few seconds while the
reviewer session runs: the cores its children use (CPU time between two
samples), their resident memory and, with ``nvidia-smi``, their VRAM. What the
tree held before the session (the agent CLI itself) is taken off. Each
session adds one record to ``.workpilot/test-placement/history.json`` of the
main project, so every task of the project shares it; ``demand`` is the
median of the last records, and the defaults of ``Demand`` until one exists.
"""

from __future__ import annotations

import json
import logging
import statistics
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psutil
from foundation.file_utils import write_json_atomic
from foundation.platform import find_executable

from .decide import MIB, Demand

__all__ = ["HISTORY_LIMIT", "Meter", "Usage", "demand", "history_path", "record"]

logger = logging.getLogger(__name__)

HISTORY_LIMIT = 20
_MEDIAN_OF = 10
_SAMPLE_SECONDS = 3.0
_WORKTREE_MARKERS = (
    (".workpilot", "worktrees"),
    (".workpilot", "github", "pr", "worktrees"),
)


def _main_project(path: Path) -> Path:
    """The project a worktree belongs to (``security.guardrail_policy``'s rule)."""
    parts = Path(path).parts
    for index in range(len(parts)):
        for marker in _WORKTREE_MARKERS:
            end = index + len(marker)
            if tuple(parts[index:end]) == marker and end < len(parts):
                return Path(*parts[:index])
    return Path(path)


def history_path(project_dir: Path) -> Path:
    return _main_project(project_dir) / ".workpilot" / "test-placement" / "history.json"


@dataclass(frozen=True)
class Usage:
    cores: float
    ram: int
    vram: int
    seconds: float


def _read(project_dir: Path) -> list[dict[str, Any]]:
    path = history_path(project_dir)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    runs = data.get("runs") if isinstance(data, dict) else None
    return [run for run in runs or [] if isinstance(run, dict)]


def _positive(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if value >= 0 else None


def demand(project_dir: Path) -> Demand:
    """The median of the last measured suites, or the defaults."""
    rows = []
    for run in _read(project_dir)[-_MEDIAN_OF:]:
        cores, ram, vram = (_positive(run.get(key)) for key in ("cores", "ram", "vram"))
        if cores is not None and ram is not None:
            rows.append((cores, ram, vram or 0.0))
    if not rows:
        return Demand()
    return Demand(
        cores=max(0.5, statistics.median(row[0] for row in rows)),
        ram=int(statistics.median(row[1] for row in rows)),
        vram=int(statistics.median(row[2] for row in rows)),
        runs=len(rows),
    )


def record(project_dir: Path, usage: Usage) -> None:
    """Add one measured session; a failure is logged, never raised."""
    runs = _read(project_dir)
    runs.append(
        {
            "at": int(time.time()),
            "cores": round(usage.cores, 2),
            "ram": int(usage.ram),
            "vram": int(usage.vram),
            "seconds": round(usage.seconds, 1),
        }
    )
    path = history_path(project_dir)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(path, {"runs": runs[-HISTORY_LIMIT:]})
    except OSError as exc:
        logger.warning("could not write %s: %s", path, exc)


def _gpu_memory_by_pid() -> dict[int, int]:
    smi = find_executable("nvidia-smi")
    if not smi:
        return {}
    try:
        result = subprocess.run(
            [
                smi,
                "--query-compute-apps=pid,used_memory",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return {}
    used: dict[int, int] = {}
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) == 2 and parts[0].isdigit() and parts[1].isdigit():
            used[int(parts[0])] = int(parts[1]) * MIB
    return used


class Meter:
    """Peak use of the current process's children while the block runs.

    ``with Meter() as meter: ...`` then ``meter.usage``. Sampling happens in a
    daemon thread and never raises into the session.
    """

    def __init__(self, interval: float = _SAMPLE_SECONDS, gpu: bool = True):
        self._interval = interval
        self._gpu = gpu
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._cpu_seen: dict[int, float] = {}
        self._base_ram = 0
        self._base_vram = 0
        self._peak_ram = 0
        self._peak_vram = 0
        self._core_samples: list[float] = []
        self._started = 0.0
        self.usage: Usage | None = None

    def _children(self) -> list[psutil.Process]:
        try:
            return psutil.Process().children(recursive=True)
        except psutil.Error:
            return []

    def _read(self) -> tuple[int, float, int]:
        """(resident memory, CPU seconds, VRAM) of the tree now."""
        ram, cpu_total, pids = 0, 0.0, set()
        for child in self._children():
            try:
                with child.oneshot():
                    ram += child.memory_info().rss
                    times = child.cpu_times()
                    cpu = times.user + times.system
                pids.add(child.pid)
            except psutil.Error:
                continue
            cpu_total += cpu - self._cpu_seen.get(child.pid, cpu)
            self._cpu_seen[child.pid] = cpu
        vram = 0
        if self._gpu:
            vram = sum(v for pid, v in _gpu_memory_by_pid().items() if pid in pids)
        return ram, cpu_total, vram

    def _loop(self) -> None:
        last = time.monotonic()
        while not self._stop.wait(self._interval):
            ram, cpu, vram = self._read()
            now = time.monotonic()
            elapsed = max(now - last, 1e-6)
            last = now
            self._core_samples.append(cpu / elapsed)
            self._peak_ram = max(self._peak_ram, ram)
            self._peak_vram = max(self._peak_vram, vram)

    def __enter__(self) -> Meter:
        self._started = time.monotonic()
        self._base_ram, _cpu, self._base_vram = self._read()
        self._peak_ram, self._peak_vram = self._base_ram, self._base_vram
        self._thread = threading.Thread(
            target=self._loop, name="test-placement-meter", daemon=True
        )
        self._thread.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self._interval + 5)
        cores = 0.0
        if self._core_samples:
            ordered = sorted(self._core_samples)
            cores = ordered[min(len(ordered) - 1, int(len(ordered) * 0.9))]
        self.usage = Usage(
            cores=cores,
            ram=max(0, self._peak_ram - self._base_ram),
            vram=max(0, self._peak_vram - self._base_vram),
            seconds=time.monotonic() - self._started,
        )
