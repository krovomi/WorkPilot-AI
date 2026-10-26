"""Ingest external signals (coverage.xml, Dependency Sentinel) into the
shape expected by ``LongevityScorer.score_report``.

Two helpers, both pure and side-effect free:

* :func:`parse_coverage_xml` — Cobertura-format XML → ratio in [0.0, 1.0]
* :func:`load_sentinel_vulnerabilities` — read the latest Dependency
  Sentinel scan from disk → list of ``{"severity": ..., "package": ...}``

Together they let the scorer consume real CI output without changing its
public API.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from xml.etree import ElementTree as ET  # noqa: S405 - ParseError type only

from defusedxml.ElementTree import parse as defused_parse
from foundation.api_safety import validated_dir

logger = logging.getLogger(__name__)

# The Dependency Sentinel of the former continuous-AI daemon persisted a
# snapshot at this relative path. The daemon is gone (replaced by
# automations, see docs/architecture/automations.md); a scan written there
# by another tool keeps the same shape.
SENTINEL_LATEST_SCAN_REL = (
    Path(".workpilot") / "continuous-ai" / "deps" / "latest_scan.json"
)

# A scan older than this says what the dependencies were, not what they are.
SENTINEL_MAX_AGE_SECONDS = 30 * 24 * 3600

# Cobertura puts the project-level coverage on the root <coverage> element
# as a 0..1 fraction in the line-rate attribute. We accept either that
# attribute on the root, or fall back to the more granular per-package
# rates if needed.
_COBERTURA_LINE_RATE_ATTR = "line-rate"


class CoverageParseError(ValueError):
    """Raised when ``coverage.xml`` cannot be parsed into a ratio."""


def parse_coverage_xml(path: str | Path) -> float:
    """Parse a Cobertura ``coverage.xml`` and return the line-coverage ratio.

    Returns a float in [0.0, 1.0]. Raises :class:`CoverageParseError` for
    malformed input or a missing line-rate attribute. Any value outside
    [0, 1] is clamped (defensive — coverage tools occasionally emit -nan
    or > 1 for empty modules).
    """
    # The path comes from the request body. Normalise it the same way every
    # other caller-supplied path in this backend is normalised, and keep the
    # resolved value out of the messages below — they reach an HTTP caller.
    try:
        p = validated_dir(str(path), "coverage_xml", must_exist=False)
    except ValueError as e:
        raise CoverageParseError(str(e)) from None
    if not p.is_file():
        raise CoverageParseError("coverage.xml not found")

    try:
        tree = defused_parse(p)
    except ET.ParseError as e:
        raise CoverageParseError("invalid XML in coverage.xml") from e

    root = tree.getroot()
    rate = root.get(_COBERTURA_LINE_RATE_ATTR)
    if rate is None:
        # Try aggregating per-package line-rate (some emitters omit it on root).
        packages = root.findall(".//package")
        if not packages:
            raise CoverageParseError(
                f"no '{_COBERTURA_LINE_RATE_ATTR}' attribute on root or per-package "
                f"in {p}"
            )
        rates = []
        for pkg in packages:
            r = pkg.get(_COBERTURA_LINE_RATE_ATTR)
            if r is None:
                continue
            try:
                rates.append(float(r))
            except ValueError:
                continue
        if not rates:
            raise CoverageParseError(f"no parseable per-package rates in {p}")
        ratio = sum(rates) / len(rates)
    else:
        try:
            ratio = float(rate)
        except ValueError as e:
            raise CoverageParseError(
                f"non-numeric '{_COBERTURA_LINE_RATE_ATTR}' in {p}: {rate!r}"
            ) from e

    # Clamp + sanity check.
    if ratio != ratio:  # NaN
        raise CoverageParseError(f"NaN coverage ratio in {p}")
    return max(0.0, min(1.0, ratio))


def sentinel_snapshot_is_current(
    project_dir: str | Path, *, now: float | None = None
) -> bool:
    """Whether a snapshot exists and was scanned within the last 30 days.

    A snapshot nobody refreshes would keep scoring yesterday's
    vulnerabilities (or yesterday's "all clean") as today's, so an old or
    undated one is no signal at all.
    """
    snapshot = Path(project_dir) / SENTINEL_LATEST_SCAN_REL
    if not snapshot.is_file():
        return False
    try:
        scanned_at = json.loads(snapshot.read_text(encoding="utf-8")).get("scanned_at")
    except (OSError, json.JSONDecodeError, AttributeError):
        return False
    if not isinstance(scanned_at, (int, float)) or isinstance(scanned_at, bool):
        return False
    current = time.time() if now is None else now
    return 0 <= current - scanned_at <= SENTINEL_MAX_AGE_SECONDS


def load_sentinel_vulnerabilities(project_dir: str | Path) -> list[dict]:
    """Read the latest Dependency Sentinel snapshot and return vuln dicts.

    Returns ``[]`` when the snapshot file is missing or unreadable — the
    scorer treats an empty list and ``None`` differently (None means
    "no signal"; [] means "scanned, all clean"), so callers should pass
    ``None`` instead of ``[]`` when they don't want the vuln penalty
    applied at all.

    The returned dicts contain at least ``severity`` (the only field
    required by ``LongevityScorer._vuln_penalty``); ``package``,
    ``current_version``, and ``advisory`` are passed through too so the
    summary remains useful.
    """
    snapshot = Path(project_dir) / SENTINEL_LATEST_SCAN_REL
    if not snapshot.exists():
        logger.debug("Sentinel snapshot not present at %s", snapshot)
        return []

    try:
        data = json.loads(snapshot.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        logger.warning("Could not read Sentinel snapshot %s: %s", snapshot, e)
        return []

    vulns = data.get("vulnerabilities") or []
    if not isinstance(vulns, list):
        logger.warning("Sentinel snapshot has malformed 'vulnerabilities' field")
        return []

    cleaned: list[dict] = []
    for v in vulns:
        if not isinstance(v, dict):
            continue
        # severity is the only field the scorer requires; default to 'low'
        # so a malformed entry does not silently drop signal.
        cleaned.append(
            {
                "severity": str(v.get("severity", "low")),
                "package": v.get("package"),
                "current_version": v.get("current_version"),
                "advisory": v.get("advisory"),
                "fixed_in": v.get("fixed_in"),
                "is_direct": v.get("is_direct"),
                "ecosystem": v.get("ecosystem"),
            }
        )
    return cleaned
