"""One spending cap per session, the same for every provider.

The Claude Agent SDK stops a session at ``max_budget_usd`` on its own. The
other clients had no cap: an OpenAI-style loop could spend until ``max_turns``.
``SessionBudget`` gives them the same one, measured from the client's usage
ledger and priced from ``cost_intelligence.catalog``; the session runner checks
it after every message. A client that enforces a budget itself says so
(``enforces_own_budget``) and is left alone.

The cap is ``AUTO_CLAUDE_MAX_BUDGET_USD`` (the variable the SDK cap already
reads, 5 USD by default); 0 or less removes it. A model without a known price
cannot be measured, so its session is not capped: the harness never stops work
on a number it cannot compute.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass
from typing import Any

from harness.domain import TokenPrices, UsageLedger, calls_cost, over_budget

logger = logging.getLogger(__name__)

BUDGET_ENV = "AUTO_CLAUDE_MAX_BUDGET_USD"
DEFAULT_BUDGET_USD = 5.0

# Client provider names that the pricing catalog files under another name.
# Data, not a branch: a new client either uses a catalog name or adds a row.
_CATALOG_PROVIDER = {
    "claude": "anthropic",
    "openai-codex-cli": "openai",
    "antigravity": "google",
    "local": "ollama",
    "lmstudio": "ollama",
}


def session_budget_usd() -> float | None:
    """The per-session cap in USD, or None when it is switched off (0 or less).

    An unreadable value falls back to the default with a warning, rather than
    leaving every session uncapped.
    """
    raw = os.environ.get(BUDGET_ENV, "").strip()
    if not raw:
        return DEFAULT_BUDGET_USD
    try:
        value = float(raw)
    except ValueError:
        value = math.nan
    if not math.isfinite(value):
        logger.warning(
            "Invalid %s=%r — using %.2f USD", BUDGET_ENV, raw, DEFAULT_BUDGET_USD
        )
        return DEFAULT_BUDGET_USD
    return value if value > 0 else None


def prices_for(provider: str | None, model: str | None) -> TokenPrices | None:
    """The catalog's prices for a client's provider and model, if it has them.

    A model named ``vendor/model`` (OpenCode) is priced under its vendor.
    """
    if not provider or not model:
        return None
    vendor, _, name = model.partition("/")
    if name:
        provider, model = vendor, name
    provider = _CATALOG_PROVIDER.get(provider.lower(), provider.lower())
    try:
        from cost_intelligence.catalog import PricingCatalog

        pricing = PricingCatalog().get_pricing(provider, model)
    except Exception:  # noqa: BLE001 - no price is a known outcome, not an error
        return None
    if pricing is None:
        return None
    return TokenPrices(
        input=pricing.input,
        output=pricing.output,
        cache_read=pricing.cache_read,
        cache_write=pricing.cache_write,
    )


@dataclass(frozen=True)
class SessionBudget:
    """The cap of one session and the prices that measure it."""

    cap_usd: float
    prices: TokenPrices | None

    @property
    def measurable(self) -> bool:
        return self.prices is not None

    def spent(self, ledger: UsageLedger | None) -> float | None:
        return calls_cost(ledger.calls, self.prices) if ledger is not None else None

    def exceeded(self, ledger: UsageLedger | None) -> bool:
        return over_budget(self.spent(ledger), self.cap_usd)


def budget_for(client: Any) -> SessionBudget | None:
    """The budget the session runner enforces for ``client``, or None.

    None when the client enforces its own budget or the cap is switched off.
    """
    if getattr(client, "enforces_own_budget", False):
        return None
    cap = session_budget_usd()
    if cap is None:
        return None
    try:
        provider = client.provider_name()
    except Exception:  # noqa: BLE001 - a fake or partial client
        provider = None
    return SessionBudget(cap, prices_for(provider, getattr(client, "model", None)))
