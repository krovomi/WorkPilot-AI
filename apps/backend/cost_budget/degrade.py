"""The lighter model a phase runs on once its budget is nearly spent.

With ``degrade: true``, a limit (task or project) past its warning threshold
steps a flagship model down to its provider's standard tier, and past its
critical threshold down to the fast tier. A model already at or under the
target stays as chosen; a local one (no money spent) too. The step stays with
the same provider: its credentials, its tools and its harness are the ones the
task was set up with.

The tiers are the registry's (``models_registry``). Within a tier the newest
model is taken (the highest version numbers in its id), so Opus 5.5 steps to
Sonnet 5.5, not to the oldest Sonnet still listed. A model the registry does
not know is left alone: a guessed replacement could be one the provider does
not serve.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable

logger = logging.getLogger(__name__)

ORDER = ("flagship", "standard", "fast")
_NUMBERS = re.compile(r"\d+")


def _version(model_id: str) -> tuple[int, ...]:
    return tuple(int(n) for n in _NUMBERS.findall(model_id))


def newest(provider: str, tier: str) -> str | None:
    from models_registry import REGISTRY

    found = [e.model_id for e in REGISTRY if e.provider == provider and e.tier == tier]
    return max(found, key=_version) if found else None


def step_down(
    model: str,
    steps: int,
    default_of: Callable[[str, str], str | None] | None = None,
) -> str | None:
    """``model`` moved ``steps`` tiers down, or None when it stays."""
    from models_registry import REGISTRY

    entry = next((e for e in REGISTRY if e.model_id == model), None)
    if entry is None or entry.tier not in ORDER or steps <= 0:
        return None
    current = ORDER.index(entry.tier)
    target = min(current + steps, len(ORDER) - 1)
    if target == current:
        return None
    tier = ORDER[target]
    lighter = default_of(entry.provider, tier) if default_of else None
    lighter = lighter or newest(entry.provider, tier)
    return lighter if lighter and lighter != model else None


def budget_model(
    model: str,
    steps: int,
    phase: str = "",
    default_of: Callable[[str, str], str | None] | None = None,
) -> str:
    lighter = step_down(model, steps, default_of) if model else None
    if not lighter:
        return model
    logger.warning(
        "Cost budget nearly spent: %s runs on %s instead of %s",
        phase or "phase",
        lighter,
        model,
    )
    return lighter


__all__ = ["budget_model", "newest", "step_down"]
