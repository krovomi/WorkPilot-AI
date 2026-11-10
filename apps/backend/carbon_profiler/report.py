"""The carbon report: totals, breakdowns, trend, equivalents and advice.

Everything is computed from the ledger, with no model. The advice is a list
of codes with figures, and the page words them in the app's language. Each
piece of advice is given only when the ledger shows what it is about:

* ``review_on_fast``: large models write most of the QA and review phases,
  where a fast model is usually enough.
* ``use_cache``: a provider that caches prompts reads few of its tokens from
  cache.
* ``cleaner_region``: a provider runs on a grid at least twice as carbon-heavy
  as the cleanest region it offers (an Azure, Bedrock or Vertex region).
* ``local_vs_cloud``: local runs cost more, or less, per answer than cloud runs.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any

from .factors import GRID_INTENSITY, TIER_WH_PER_1K_OUTPUT
from .ledger import Row

# A new petrol car in the EU emits about 120 g CO₂ per km (EEA, WLTP).
CAR_G_PER_KM = 120.0
REVIEW_PHASES = ("qa", "review", "validation", "critic")
CACHING_PROVIDERS = frozenset(
    {
        "anthropic",
        "claude",
        "openai",
        "google",
        "gemini",
        "deepseek",
        "bedrock",
        "vertex",
    }
)
REGION_CHOICE = {
    "azure": "nordics",
    "openai": "nordics",
    "bedrock": "fr",
    "aws": "fr",
    "vertex": "nordics",
    "google": "nordics",
}


def _sum(rows: Iterable[Row], key: str) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = defaultdict(
        lambda: {"co2G": 0.0, "kwh": 0.0, "calls": 0}
    )
    for row in rows:
        name = getattr(row, key) or "—"
        out[name]["co2G"] += row.estimate.co2_g
        out[name]["kwh"] += row.estimate.kwh
        out[name]["calls"] += 1
    return dict(sorted(out.items(), key=lambda kv: -kv[1]["co2G"]))


def advice(rows: list[Row]) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    review = [
        r for r in rows if any(p in (r.phase or r.agent).lower() for p in REVIEW_PHASES)
    ]
    review_co2 = sum(r.estimate.co2_g for r in review)
    large = sum(r.estimate.co2_g for r in review if r.estimate.tier == "large")
    if review_co2 > 0 and large / review_co2 >= 0.5:
        saving = 1 - TIER_WH_PER_1K_OUTPUT["small"] / TIER_WH_PER_1K_OUTPUT["large"]
        found.append(
            {
                "code": "review_on_fast",
                "share": round(large / review_co2 * 100),
                "saving": round(saving * 100),
            }
        )
    by_provider: dict[str, list[Row]] = defaultdict(list)
    for row in rows:
        by_provider[row.provider.lower()].append(row)
    for provider, items in sorted(by_provider.items()):
        tokens = sum(r.tokens_in for r in items)
        cached = sum(r.cache_read for r in items)
        if (
            provider in CACHING_PROVIDERS
            and tokens >= 200_000
            and cached / tokens < 0.3
        ):
            found.append(
                {
                    "code": "use_cache",
                    "provider": provider,
                    "share": round(cached / tokens * 100),
                }
            )
        region = items[0].estimate.region
        target = REGION_CHOICE.get(provider)
        if target and GRID_INTENSITY.get(region, 0) >= 2 * GRID_INTENSITY[target]:
            found.append(
                {
                    "code": "cleaner_region",
                    "provider": provider,
                    "from": region,
                    "to": target,
                    "saving": round(
                        (1 - GRID_INTENSITY[target] / GRID_INTENSITY[region]) * 100
                    ),
                }
            )
    local = [r for r in rows if r.source == "llm_local" and r.tokens_out]
    cloud = [r for r in rows if r.source == "llm_cloud" and r.tokens_out]
    if local and cloud:
        per_local = (
            sum(r.estimate.kwh for r in local) / sum(r.tokens_out for r in local) * 1000
        )
        per_cloud = (
            sum(r.estimate.kwh for r in cloud) / sum(r.tokens_out for r in cloud) * 1000
        )
        found.append(
            {
                "code": "local_vs_cloud",
                "localWh": round(per_local * 1000, 3),
                "cloudWh": round(per_cloud * 1000, 3),
            }
        )
    return found


def build(
    rows: list[Row], *, month: str = "", now: datetime | None = None
) -> dict[str, Any]:
    """The report of ``month`` (YYYY-MM), or of the whole ledger."""
    now = now or datetime.now(UTC)
    chosen = [r for r in rows if not month or r.month == month]
    total_co2 = sum(r.estimate.co2_g for r in chosen)
    total_kwh = sum(r.estimate.kwh for r in chosen)
    months: dict[str, dict[str, float]] = defaultdict(lambda: {"co2G": 0.0, "kwh": 0.0})
    for row in rows:
        if row.month:
            months[row.month]["co2G"] += row.estimate.co2_g
            months[row.month]["kwh"] += row.estimate.kwh
    stamps = [r.at for r in chosen if r.at]
    unknown_hosts = sorted(
        {
            r.provider
            for r in chosen
            if not r.estimate.host_known and r.source == "llm_cloud"
        }
    )
    return {
        "month": month,
        "records": [r.to_dict() for r in chosen[-500:]],
        "recordCount": len(chosen),
        "totalKwh": total_kwh,
        "totalCo2G": total_co2,
        "periodStart": min(stamps).isoformat() if stamps else "",
        "periodEnd": max(stamps).isoformat() if stamps else "",
        "byProvider": {k: v["co2G"] for k, v in _sum(chosen, "provider").items()},
        "byModel": {k: v["co2G"] for k, v in _sum(chosen, "model").items()},
        "byPhase": _sum(chosen, "phase"),
        "byTask": dict(list(_sum(chosen, "task").items())[:20]),
        "months": [{"month": m, **v} for m, v in sorted(months.items())[-12:]],
        "carKm": round(total_co2 / CAR_G_PER_KM, 2),
        "advice": advice(chosen),
        "unknownHosts": unknown_hosts,
        "generatedAt": now.isoformat(timespec="seconds"),
        "summary": f"{total_kwh:.4f} kWh, {total_co2:.1f} gCO2e over {len(chosen)} calls (estimated)",
    }


__all__ = ["CAR_G_PER_KM", "advice", "build"]
