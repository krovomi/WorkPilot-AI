"""Best-of-N: build one task N ways, rank them on numbers, let the person pick.

See docs/architecture/best-of-n.md.
"""

from .lifecycle import adopt, discard, prepare, rank
from .rank import CRITERIA, VariantScore, measure_variant, rank_variants
from .variants import (
    MAX_VARIANTS,
    MIN_VARIANTS,
    STATE_FILENAME,
    BestOfNError,
    Variant,
    parse_variants,
    read_state,
    variant_spec_id,
)

__all__ = [
    "CRITERIA",
    "MAX_VARIANTS",
    "MIN_VARIANTS",
    "STATE_FILENAME",
    "BestOfNError",
    "Variant",
    "VariantScore",
    "adopt",
    "discard",
    "measure_variant",
    "parse_variants",
    "prepare",
    "rank",
    "rank_variants",
    "read_state",
    "variant_spec_id",
]
