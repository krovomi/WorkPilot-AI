"""The monthly ESG export: the month's figures in the shape reporting asks for.

The figures map onto two frameworks:

* **CSRD / ESRS E1-6** (gross GHG emissions). Calls to a cloud model are
  purchased services, so they count in Scope 3, category 1 (purchased goods and
  services). A local model draws the company's own electricity, so it counts
  in Scope 2, location-based.
* **GRI 305-3** (other indirect, Scope 3) and **GRI 302-1** (energy within the
  organisation, for the local part).

Every figure is an estimate (see ``factors.py``). The export says so, and
gives the method, the factors used and the providers whose host is a guess.
Formats: ``json``, ``csv`` (one line per provider and model), ``md``.
"""

from __future__ import annotations

import csv
import io
import json
from collections import defaultdict
from typing import Any

from .config import CarbonConfig
from .factors import CACHE_READ_WEIGHT, INPUT_WEIGHT, TIER_WH_PER_1K_OUTPUT
from .ledger import Row

FORMATS = ("json", "csv", "md")


def document(
    rows: list[Row], month: str, cfg: CarbonConfig, project: str
) -> dict[str, Any]:
    chosen = [r for r in rows if r.month == month]
    lines: dict[tuple[str, str, str], dict[str, float]] = defaultdict(
        lambda: {"calls": 0, "tokensIn": 0, "tokensOut": 0, "kwh": 0.0, "co2Kg": 0.0}
    )
    for row in chosen:
        scope = "scope2" if row.source == "llm_local" else "scope3_cat1"
        line = lines[(scope, row.provider or "—", row.model or "—")]
        line["calls"] += 1
        line["tokensIn"] += row.tokens_in
        line["tokensOut"] += row.tokens_out
        line["kwh"] += row.estimate.kwh
        line["co2Kg"] += row.estimate.co2_g / 1000
    scope2 = sum(v["co2Kg"] for (s, _, _), v in lines.items() if s == "scope2")
    scope3 = sum(v["co2Kg"] for (s, _, _), v in lines.items() if s == "scope3_cat1")
    local_kwh = sum(v["kwh"] for (s, _, _), v in lines.items() if s == "scope2")
    return {
        "project": project,
        "period": month,
        "unit": "kg CO2e",
        "estimated": True,
        "totals": {
            "co2Kg": scope2 + scope3,
            "kwh": sum(v["kwh"] for v in lines.values()),
            "scope2LocationBasedKg": scope2,
            "scope3Category1Kg": scope3,
            "energyWithinOrganisationKwh": local_kwh,
        },
        "frameworks": {
            "ESRS E1-6": {"scope2LocationBased": scope2, "scope3Category1": scope3},
            "GRI 305-3": scope3,
            "GRI 302-1": local_kwh,
        },
        "lines": [
            {"scope": s, "provider": p, "model": m, **v}
            for (s, p, m), v in sorted(lines.items())
        ],
        "method": {
            "whPer1kOutputTokens": TIER_WH_PER_1K_OUTPUT,
            "inputWeight": INPUT_WEIGHT,
            "cacheReadWeight": CACHE_READ_WEIGHT,
            "localRegion": cfg.region,
            "localPowerW": cfg.power_w,
            "overrides": cfg.factors,
            "hostsGuessed": sorted(
                {r.provider for r in chosen if not r.estimate.host_known}
            ),
            "note": (
                "Estimates from tokens, model size, data centre PUE and grid intensity; "
                "providers publish no per-call energy. See docs/architecture/carbon-profiler.md."
            ),
        },
    }


def render(doc: dict[str, Any], fmt: str) -> str:
    if fmt == "json":
        return json.dumps(doc, indent=2, ensure_ascii=False)
    if fmt == "csv":
        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(
            [
                "period",
                "scope",
                "provider",
                "model",
                "calls",
                "tokens_in",
                "tokens_out",
                "kwh",
                "kg_co2e",
            ]
        )
        for line in doc["lines"]:
            writer.writerow(
                [
                    doc["period"],
                    line["scope"],
                    line["provider"],
                    line["model"],
                    line["calls"],
                    line["tokensIn"],
                    line["tokensOut"],
                    f"{line['kwh']:.6f}",
                    f"{line['co2Kg']:.6f}",
                ]
            )
        return out.getvalue()
    if fmt == "md":
        t = doc["totals"]
        rows = "\n".join(
            f"| {line['scope']} | {line['provider']} | {line['model']} | {line['calls']} | {line['kwh']:.4f} | {line['co2Kg']:.4f} |"
            for line in doc["lines"]
        )
        return (
            f"# Carbon footprint of AI usage, {doc['period']}\n\n"
            f"Project: {doc['project']}. All figures are estimates.\n\n"
            f"- Total: {t['co2Kg']:.4f} kg CO2e, {t['kwh']:.4f} kWh\n"
            f"- ESRS E1-6 Scope 2 (location-based, local models): {t['scope2LocationBasedKg']:.4f} kg CO2e\n"
            f"- ESRS E1-6 Scope 3 category 1 (cloud models): {t['scope3Category1Kg']:.4f} kg CO2e\n"
            f"- GRI 302-1 energy within the organisation: {t['energyWithinOrganisationKwh']:.4f} kWh\n\n"
            "| Scope | Provider | Model | Calls | kWh | kg CO2e |\n|---|---|---|---|---|---|\n"
            f"{rows}\n\n## Method\n\n{doc['method']['note']}\n"
        )
    raise ValueError(f"unknown format {fmt}")


__all__ = ["FORMATS", "document", "render"]
