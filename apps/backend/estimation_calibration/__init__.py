"""Smart Estimation calibration loop (issue #367).

A per-repository record of what each merged spec was estimated to need
against what it actually used (cost, tokens, QA iterations, files changed),
and the correction factors learned from it. No model call: a median of
ratios with outliers excluded, so every provider feeds the same dataset.
No duration is estimated or recorded anywhere (product rule).

See docs/architecture/smart-estimation.md.
"""

from .categories import CATEGORIES, categorize
from .dimensions import breakdown
from .model import METRICS, MIN_SAMPLES, calibrate
from .store import load, record_adjustment, record_sample, reset

__all__ = [
    "CATEGORIES",
    "METRICS",
    "MIN_SAMPLES",
    "breakdown",
    "calibrate",
    "categorize",
    "load",
    "record_adjustment",
    "record_sample",
    "reset",
]
