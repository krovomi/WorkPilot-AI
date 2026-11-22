"""Where a task's long suites run: this machine, the forge's CI or the server.

The QA reviewer runs the whole suite of a full review (regression check, build,
end-to-end). On a machine already running other tasks, that suite slows the
person's computer down. A card says where its long suites go
(``WORKPILOT_TEST_PLACEMENT``, the project default in ``TEST_PLACEMENT``):

- ``machine`` or ``ci``: the person chose, nothing is computed;
- ``auto`` (the default): ``decide`` reads what the machine running WorkPilot
  has left (``machine.sample``: cores and their load, free memory, GPU and
  VRAM, the other builds running) against what this project's suite took the
  last times (``demand``, measured during the local QA sessions). Alone, or
  with room, the suite stays here. Without room it goes to the forge's CI when
  the task's PR exists, else to the WorkPilot server when one is connected,
  else to the CI on a branch pushed without a PR when the project allows it,
  else it waits for room (bounded), then runs here: a suite is never skipped.

``prepare`` takes that decision before the reviewer session, writes it to
``test_placement.json`` in the spec directory (the card shows it, the app reads
it to push the branch and follow the pipeline), and gives the reviewer the
words that move its full suite elsewhere. No model is asked anything.
"""

from .decide import Decision, Demand, Gpu, Machine, Routes, decide, fits
from .settings import PlacementSettings, load_settings

__all__ = [
    "Decision",
    "Demand",
    "Gpu",
    "Machine",
    "PlacementSettings",
    "Routes",
    "decide",
    "fits",
    "load_settings",
]
