"""
Accessibility Scanner — WCAG 2.2 checks read from the source (#391).

Every markup the project ships (HTML, JSX/TSX, Vue, Svelte, Astro, Angular,
Razor/Blazor, PHP/Blade, Twig, ERB, Handlebars) and its CSS go through one
reader (``markup.py``) and one rule set (``rules.py``): text alternatives,
labels, names, headings, page language and title, keyboard, ARIA, captions,
focus visibility, contrast (``contrast.py``) and target size. No model is
called. A violation inside conditional markup, or on a component imported
from a package, carries a note: the first may not render, the second is
fixed where it is used or by its maintainer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum

from agents.scanner_base import BaseScanner, BaseScanReport

from .contrast import Tokens
from .fixer import fix_id, propose
from .markup import parse
from .rules import check

logger = logging.getLogger(__name__)


class WcagLevel(str, Enum):
    A = "A"
    AA = "AA"
    AAA = "AAA"


class A11ySeverity(str, Enum):
    CRITICAL = "critical"
    SERIOUS = "serious"
    MODERATE = "moderate"
    MINOR = "minor"


@dataclass
class A11yViolation:
    """A single accessibility violation."""

    rule_id: str
    description: str
    severity: A11ySeverity
    wcag_level: WcagLevel
    wcag_criteria: str = ""
    file: str = ""
    line: int = 0
    element: str = ""
    suggestion: str = ""
    detail: str = ""
    conditional: bool = False
    """Inside markup that may not render (``v-if``, ``*ngIf``, ``{cond && …}``)."""
    external: bool = False
    """On a component imported from a package: fix it where it is used, or report it upstream."""
    fix_id: str = ""
    fix: dict | None = None
    """The one-click fix, when one can be derived: attribute and value."""


# Accessibility uses a richer severity vocabulary than the default
# {critical, high, medium, low, info} — only "critical" blocks by default.
_A11Y_BLOCKING = frozenset({A11ySeverity.CRITICAL.value})


@dataclass
class A11yReport(BaseScanReport[A11yViolation]):
    """Accessibility audit report.

    Backed by :class:`agents.scanner_base.BaseScanReport`. Keeps a
    ``violations`` alias because existing callers (runners, tests) already
    iterate ``.violations``; new code should prefer ``.findings``.
    """

    target_level: WcagLevel = WcagLevel.AA
    blocking_severities: frozenset[str] = field(default_factory=lambda: _A11Y_BLOCKING)

    @property
    def violations(self) -> list[A11yViolation]:
        """Back-compat alias — same list object as ``findings``."""
        return self.findings

    @violations.setter
    def violations(self, value: list[A11yViolation]) -> None:
        self.findings = value

    @property
    def critical_count(self) -> int:
        """Back-compat: a11y only considers CRITICAL findings blocking."""
        return self.blocking_count


class AccessibilityScanner(BaseScanner[A11yViolation, A11yReport]):
    """Scan files for WCAG accessibility violations.

    Usage::

        scanner = AccessibilityScanner(target_level=WcagLevel.AA)
        report = scanner.scan_file("src/App.tsx", content)
    """

    report_cls = A11yReport

    def __init__(
        self,
        target_level: WcagLevel = WcagLevel.AA,
        tokens: Tokens | None = None,
        page_lang: str = "en",
    ) -> None:
        self._target_level = target_level
        self._tokens = tokens or Tokens()
        self._page_lang = page_lang

    def _new_report(self) -> A11yReport:
        return A11yReport(target_level=self._target_level)

    def scan_file(self, file_path: str, content: str) -> A11yReport:
        """Scan a single file for violations."""
        report = A11yReport(files_scanned=1, target_level=self._target_level)
        markup = parse(file_path, content)
        hits = check(markup, self._tokens, self._target_level.value)
        fixes = propose(markup, hits, self._page_lang)
        for hit in hits:
            element = hit.element
            fid = fix_id(hit.rule.rule_id, file_path, hit.line, element)
            fix = fixes.get(fid)
            report.findings.append(
                A11yViolation(
                    rule_id=hit.rule.rule_id,
                    description=hit.rule.description,
                    severity=A11ySeverity(hit.rule.severity),
                    wcag_level=WcagLevel(hit.rule.level),
                    wcag_criteria=hit.rule.criterion,
                    file=file_path,
                    line=hit.line,
                    element=(element.source if element is not None else hit.snippet)[
                        :120
                    ],
                    suggestion=hit.rule.suggestion,
                    detail=hit.detail,
                    conditional=bool(element and element.conditional),
                    external=bool(
                        element and element.is_component and markup.is_external(element)
                    ),
                    fix_id=fid if fix else "",
                    fix={"attribute": fix.attribute, "value": fix.value}
                    if fix
                    else None,
                )
            )
        return report
