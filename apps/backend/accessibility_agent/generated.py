"""Accessibility of code a page generates, checked before it is written (#391).

Import Design (design to code) generates components; this scores what it
generated with the same rules as the Accessibility page, so the review step
says how accessible the result is before the person takes it.
"""

from __future__ import annotations

from pathlib import PurePosixPath

from .accessibility_scanner import AccessibilityScanner, WcagLevel
from .score import score

__all__ = ["MARKUP_SUFFIXES", "check_generated"]

MARKUP_SUFFIXES = frozenset(
    {
        ".html", ".htm", ".jsx", ".tsx", ".vue", ".svelte", ".astro", ".razor",
        ".cshtml", ".php", ".twig", ".erb", ".hbs", ".css", ".scss", ".sass", ".less",
    }
)  # fmt: skip
MAX_LISTED = 20


def check_generated(
    files: dict[str, str], level: WcagLevel = WcagLevel.AA
) -> dict | None:
    """Score and first violations of the generated markup; None when there is none."""
    markup = {
        path: content
        for path, content in files.items()
        if PurePosixPath(path).suffix.lower() in MARKUP_SUFFIXES
    }
    if not markup:
        return None
    try:
        report = AccessibilityScanner(target_level=level).scan_files(markup)
    except (ValueError, RecursionError):
        return None
    violations = [
        {
            "ruleId": v.rule_id,
            "description": v.description,
            "severity": v.severity.value,
            "wcagCriteria": v.wcag_criteria,
            "file": v.file,
            "line": v.line,
        }
        for v in report.violations
    ]
    return {
        "score": score(violations, report.files_scanned),
        "count": len(violations),
        "targetLevel": level.value,
        "violations": violations[:MAX_LISTED],
    }
