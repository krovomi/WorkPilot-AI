"""Carbon profiler: the estimated CO₂ footprint of the models a project uses (#365).

``ledger`` reads the calls the agents made, ``factors`` estimates each one,
``report`` totals them with advice, ``budget`` keeps the month under its
budget (alerts, degraded mode) and ``export`` writes the ESG document.
See docs/architecture/carbon-profiler.md.
"""

from .config import CarbonConfig
from .factors import Estimate, estimate

__all__ = ["CarbonConfig", "Estimate", "estimate"]
