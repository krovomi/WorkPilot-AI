"""hermes-agent as a WorkPilot capability.

Four questions, one package:

``home``       where hermes keeps its state, and what the user configured there
``soul``       the persona this repository offers, and whether it is installed
``readiness``  whether the loop can run in this checkout, and what is missing
``loop``       the cycle itself, opened by a named feature surface

The ingest that files hermes-authored skills as review candidates stays in
`learning_loop/hermes_ingest.py`, because that is where the review queue and
its rules live; this package is what decides whether to call it and who asked.
"""

from .home import hermes_home, is_trusted, read_config, trusted_project_dirs
from .loop import SURFACES, CycleReport, normalise_surface, run_cycle
from .readiness import Check, HermesReport, doctor
from .soul import SoulStatus, install_soul, repo_soul_path, soul_status

__all__ = [
    "SURFACES",
    "Check",
    "CycleReport",
    "HermesReport",
    "SoulStatus",
    "doctor",
    "hermes_home",
    "install_soul",
    "is_trusted",
    "normalise_surface",
    "read_config",
    "repo_soul_path",
    "run_cycle",
    "soul_status",
    "trusted_project_dirs",
]
