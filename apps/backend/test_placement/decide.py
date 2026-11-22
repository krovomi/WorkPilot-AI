"""The decision itself: pure, from measures already taken.

``fits`` says whether this machine can take one more suite of this project and
still leave the person room to work: a core and a tenth of the memory stay
free, and VRAM is checked only when the suite used some the last times and a
GPU can be read. ``decide`` turns the mode, the machine, the demand and the
routes the task has into one target and the reason the card shows.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

__all__ = [
    "RESERVED_CORES",
    "TARGETS",
    "Decision",
    "Demand",
    "Gpu",
    "Machine",
    "Routes",
    "decide",
    "fits",
]

GIB = 1024**3
MIB = 1024**2
#: Kept for the person's own work whatever the suites take.
RESERVED_CORES = 1.0
RESERVED_RAM_SHARE = 0.10
RESERVED_RAM_FLOOR = 1 * GIB
RESERVED_VRAM = 256 * MIB

#: ``queue``: no room and no other route; the suite waits its turn here.
TARGETS = ("machine", "server", "ci", "queue")


@dataclass(frozen=True)
class Gpu:
    name: str
    vram_total: int
    vram_used: int
    #: Utilisation in percent, ``None`` when the tool does not say.
    busy: float | None = None

    @property
    def vram_free(self) -> int:
        return max(0, self.vram_total - self.vram_used)


@dataclass(frozen=True)
class Machine:
    cores: int
    #: Whole-machine CPU load in percent, over the last sample.
    cpu_busy: float
    ram_total: int
    ram_free: int
    gpus: tuple[Gpu, ...] = ()
    #: Other WorkPilot builds running on this machine now.
    builds: int = 0
    #: Suites of other builds running here now (``queue``).
    suites: int = 0

    @property
    def free_cores(self) -> float:
        busy = min(max(self.cpu_busy, 0.0), 100.0)
        return self.cores * (1.0 - busy / 100.0)


@dataclass(frozen=True)
class Demand:
    """What one suite of this project took: the median of its last runs."""

    cores: float = 2.0
    ram: int = 2 * GIB
    vram: int = 0
    #: Local QA sessions measured; 0 means the defaults above.
    runs: int = 0


@dataclass(frozen=True)
class Routes:
    """Where else this task's suite can go."""

    #: The app follows a pushed branch's pipeline after the build.
    ci: bool = False
    has_pr: bool = False
    #: A WorkPilot server the app hands the suite to.
    server: bool = False
    branch_push: bool = False


@dataclass(frozen=True)
class Decision:
    target: str
    #: A closed list the card translates: ``chosen``, ``alone``, ``room``,
    #: ``pr``, ``server``, ``branch_push``, ``no_route``, ``turn``,
    #: ``not_followed`` (the CI was chosen but the app does not follow it).
    reason: str
    mode: str
    #: What fell short (``cpu``, ``ram``, ``vram``), empty when it fits.
    short: tuple[str, ...] = ()
    facts: dict[str, Any] = field(default_factory=dict)

    @property
    def runs_here(self) -> bool:
        return self.target == "machine"

    def to_dict(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "reason": self.reason,
            "mode": self.mode,
            "short": list(self.short),
            "facts": dict(self.facts),
        }


def fits(machine: Machine, demand: Demand) -> tuple[str, ...]:
    """What this machine lacks to take the suite; empty when it can."""
    short: list[str] = []
    if machine.free_cores - demand.cores < RESERVED_CORES:
        short.append("cpu")
    reserve = max(RESERVED_RAM_FLOOR, int(machine.ram_total * RESERVED_RAM_SHARE))
    if machine.ram_free - demand.ram < reserve:
        short.append("ram")
    if demand.vram > 0 and machine.gpus:
        if max(gpu.vram_free for gpu in machine.gpus) - demand.vram < RESERVED_VRAM:
            short.append("vram")
    return tuple(short)


def _facts(machine: Machine, demand: Demand) -> dict[str, Any]:
    facts: dict[str, Any] = {
        "cores": machine.cores,
        "cpuBusy": round(machine.cpu_busy, 1),
        "ramFreeMb": machine.ram_free // MIB,
        "ramTotalMb": machine.ram_total // MIB,
        "builds": machine.builds,
        "suites": machine.suites,
        "needCores": round(demand.cores, 1),
        "needRamMb": demand.ram // MIB,
        "measuredRuns": demand.runs,
    }
    if machine.gpus:
        best = max(machine.gpus, key=lambda gpu: gpu.vram_free)
        facts["vramFreeMb"] = best.vram_free // MIB
        facts["needVramMb"] = demand.vram // MIB
    return facts


def decide(mode: str, machine: Machine, demand: Demand, routes: Routes) -> Decision:
    """Where this suite runs. A manual mode is obeyed; ``auto`` computes."""
    facts = _facts(machine, demand)
    if mode == "machine" or (mode == "ci" and routes.ci):
        return Decision(mode, "chosen", mode, facts=facts)
    if mode == "ci":
        return Decision("machine", "not_followed", mode, facts=facts)
    if machine.builds == 0:
        return Decision("machine", "alone", "auto", facts=facts)
    short = fits(machine, demand)
    if not short:
        return Decision("machine", "room", "auto", facts=facts)
    if routes.ci and routes.has_pr:
        return Decision("ci", "pr", "auto", short, facts)
    if routes.server:
        return Decision("server", "server", "auto", short, facts)
    if routes.ci and routes.branch_push:
        return Decision("ci", "branch_push", "auto", short, facts)
    return Decision("queue", "no_route", "auto", short, facts)
