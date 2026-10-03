"""Performance, as measured — and only as measured.

Three readings feed this module:

* the summary `chrome-devtools-mcp` prints after `performance_stop_trace`
  (``- LCP: 233 ms``, ``- CLS: 0.00``…), or the same metrics read in the page
  by the Playwright fallback;
* the category scores of its `lighthouse_audit` (accessibility, best
  practices, SEO) — Lighthouse's own numbers, kept as Lighthouse computed them;
* endpoint latencies, from the calls a backend verification made.

The page score is Lighthouse's performance formula applied to the metrics the
trace measured: each metric through its log-normal curve (the `p10` and
`median` control points Lighthouse publishes), then a weighted mean. A metric
the trace did not measure is **dropped and the weights renormalised** — the
Bounty Board's rule: absent evidence is not a zero. The result says which
metrics it rests on, so "92 from LCP and CLS" never reads as a full audit.
"""

from __future__ import annotations

import math
import re
import statistics
from dataclasses import asdict, dataclass, field

__all__ = [
    "PerfResult",
    "parse_trace_summary",
    "parse_lighthouse_summary",
    "metric_score",
    "page_score",
    "latency_stats",
]

# Lighthouse 10+ scoring control points, `desktop` and `mobile` form factors.
# (FCP, Speed Index and TBT are kept even though the DevTools trace summary
# rarely reports them: the Playwright fallback measures FCP and TBT.)
_CURVES = {
    "desktop": {
        "fcp": (934, 1600),
        "si": (1311, 2300),
        "lcp": (1200, 2400),
        "tbt": (150, 350),
        "cls": (0.1, 0.25),
    },
    "mobile": {
        "fcp": (1800, 3000),
        "si": (3387, 5800),
        "lcp": (2500, 4000),
        "tbt": (200, 600),
        "cls": (0.1, 0.25),
    },
}
_WEIGHTS = {"fcp": 10, "si": 10, "lcp": 25, "tbt": 30, "cls": 25}
_INVERSE_ERFC_ONE_FIFTH = 0.9061938024368232


@dataclass
class PerfResult:
    """What was measured on one page. ``None`` means *not measured*."""

    url: str = ""
    lcp_ms: float | None = None
    cls: float | None = None
    inp_ms: float | None = None
    fcp_ms: float | None = None
    tbt_ms: float | None = None
    ttfb_ms: float | None = None
    #: 0-100, or None when no scored metric was measured.
    score: int | None = None
    #: The metrics the score rests on.
    scored_on: list[str] = field(default_factory=list)
    #: Lighthouse category scores (accessibility, best-practices, seo…).
    lighthouse: dict[str, int] = field(default_factory=dict)
    form_factor: str = "desktop"
    #: ``chrome-devtools-mcp`` or ``playwright``.
    engine: str = ""
    trace_path: str = ""
    #: Why nothing was measured, when nothing was.
    reason: str = ""

    @property
    def measured(self) -> bool:
        return any(
            v is not None
            for v in (self.lcp_ms, self.cls, self.inp_ms, self.fcp_ms, self.tbt_ms)
        )

    def to_dict(self) -> dict:
        data = asdict(self)
        data["measured"] = self.measured
        return data


def _ms(value: str, unit: str) -> float:
    number = float(value)
    return number * 1000 if unit.strip().lower() == "s" else number


_METRIC_LINE = re.compile(
    r"^\s*-\s*(?P<name>LCP|CLS|INP|FCP|TBT|TTFB)\s*:\s*(?P<value>[\d.]+)\s*(?P<unit>ms|s)?",
    re.M,
)


def parse_trace_summary(text: str) -> dict[str, float]:
    """The metrics a `performance_stop_trace` summary states, first occurrence.

    The first insight set is the page load the trace was asked for; later ones
    are navigations the page made by itself.
    """
    out: dict[str, float] = {}
    for match in _METRIC_LINE.finditer(text or ""):
        name = match.group("name").lower()
        if name in out:
            continue
        value = match.group("value")
        try:
            out[name] = (
                float(value)
                if name == "cls"
                else _ms(value, match.group("unit") or "ms")
            )
        except ValueError:
            continue
    return out


_CATEGORY_LINE = re.compile(
    r"^\s*-\s*(?P<label>[^:\n]+):\s*(?P<score>\d{1,3})\s*\((?P<id>[\w-]+)\)", re.M
)


def parse_lighthouse_summary(text: str) -> dict[str, int]:
    """``{"accessibility": 81, "best-practices": 92, …}`` from `lighthouse_audit`."""
    out: dict[str, int] = {}
    for match in _CATEGORY_LINE.finditer(text or ""):
        score = int(match.group("score"))
        if 0 <= score <= 100:
            out[match.group("id")] = score
    return out


def metric_score(metric: str, value: float, form_factor: str = "desktop") -> float:
    """Lighthouse's `getLogNormalScore` for one metric, 0..1."""
    p10, median = _CURVES.get(form_factor, _CURVES["desktop"])[metric]
    if value <= 0:
        return 1.0
    x_log_ratio = math.log(max(value / median, 5e-324))
    p10_log_ratio = -math.log(max(p10 / median, 5e-324))
    standardized = x_log_ratio * _INVERSE_ERFC_ONE_FIFTH / p10_log_ratio
    complementary = (1 - math.erf(standardized)) / 2
    if value <= p10:
        return max(0.9, min(1.0, complementary))
    if value <= median:
        return max(0.5, min(0.8999999999999, complementary))
    return max(0.0, min(0.4999999999999, complementary))


def page_score(result: PerfResult) -> PerfResult:
    """Fill ``score`` and ``scored_on`` from the measured metrics."""
    values = {
        "fcp": result.fcp_ms,
        "lcp": result.lcp_ms,
        "tbt": result.tbt_ms,
        "cls": result.cls,
    }
    measured = {k: v for k, v in values.items() if v is not None}
    if not measured:
        result.score = None
        result.scored_on = []
        return result
    total_weight = sum(_WEIGHTS[k] for k in measured)
    weighted = sum(
        metric_score(k, float(v), result.form_factor) * _WEIGHTS[k]
        for k, v in measured.items()
    )
    result.score = round(100 * weighted / total_weight)
    result.scored_on = sorted(measured)
    return result


def from_summary(
    url: str, text: str, *, engine: str, form_factor: str = "desktop"
) -> PerfResult:
    metrics = parse_trace_summary(text)
    result = PerfResult(
        url=url,
        lcp_ms=metrics.get("lcp"),
        cls=metrics.get("cls"),
        inp_ms=metrics.get("inp"),
        fcp_ms=metrics.get("fcp"),
        tbt_ms=metrics.get("tbt"),
        ttfb_ms=metrics.get("ttfb"),
        form_factor=form_factor,
        engine=engine,
    )
    if not result.measured:
        result.reason = "the trace reported no metric"
    return page_score(result)


def latency_stats(samples_ms: list[float]) -> dict:
    """p50 / p95 / max of a list of latencies, or ``{}`` with none."""
    clean = sorted(float(s) for s in samples_ms if s is not None and s >= 0)
    if not clean:
        return {}
    p95_index = max(0, math.ceil(0.95 * len(clean)) - 1)
    return {
        "count": len(clean),
        "p50_ms": round(statistics.median(clean), 1),
        "p95_ms": round(clean[p95_index], 1),
        "max_ms": round(clean[-1], 1),
    }


def latency_score(p95_ms: float | None) -> int | None:
    """A 0-100 score for an API from its p95, on a log-normal curve.

    Control points chosen for a local dev server — the only server a
    verification calls: 100 ms is good (p10), 400 ms is the median. The number
    is a signal for regressions between tasks, not a statement about
    production.
    """
    if p95_ms is None:
        return None
    if p95_ms <= 0:
        return 100
    p10, median = 100.0, 400.0
    x = math.log(p95_ms / median) * _INVERSE_ERFC_ONE_FIFTH / -math.log(p10 / median)
    return round(100 * max(0.0, min(1.0, (1 - math.erf(x)) / 2)))
