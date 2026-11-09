"""
i18n Scanner — Detect internationalisation issues in codebases.

Finds hardcoded strings, missing translation keys, inconsistent
locale files, and format/pluralisation problems.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from agents.scanner_base import BaseScanner, BaseScanReport

from .parity import PLURAL_CATEGORIES

logger = logging.getLogger(__name__)


class I18nIssueType(str, Enum):
    HARDCODED_STRING = "hardcoded_string"
    MISSING_KEY = "missing_key"
    UNUSED_KEY = "unused_key"
    INCONSISTENT_PARAMS = "inconsistent_params"
    MISSING_PLURAL = "missing_plural"
    LOCALE_FILE_MISMATCH = "locale_file_mismatch"
    ORPHAN_KEY = "orphan_key"
    UNTRANSLATED = "untranslated"
    RTL_SIDE = "rtl_side"


class I18nSeverity(str, Enum):
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"


@dataclass
class I18nIssue:
    """A single internationalisation issue."""

    issue_type: I18nIssueType
    severity: I18nSeverity
    file: str
    line: int = 0
    message: str = ""
    key: str = ""
    locale: str = ""
    suggestion: str = ""
    text: str = ""
    """The hard-coded text itself, for a ``hardcoded_string``."""
    proposed_key: str = ""
    proposed_value: str = ""
    snippet: str = ""
    reused: bool = False
    """The proposed key already exists with the same text."""
    possibly: bool = False
    """An orphan in a project that builds some keys at run time."""


# In i18n, only ``error`` blocks (warnings are advisory, info is noise).
_I18N_BLOCKING = frozenset({I18nSeverity.ERROR.value})


@dataclass
class I18nReport(BaseScanReport[I18nIssue]):
    """Report of all i18n issues found.

    Backed by :class:`agents.scanner_base.BaseScanReport`. The historical
    ``issues`` attribute is kept as an alias for ``findings`` so existing
    callers (runners, tests, frontend views) stay compatible.

    The ``summary`` property is overridden to group by issue *type*
    (hardcoded_string, missing_key, …) rather than severity, because
    that's what the frontend report view has always rendered.
    """

    locales_found: list[str] = field(default_factory=list)
    total_keys: int = 0
    coverage: dict[str, float] = field(default_factory=dict)
    blocking_severities: frozenset[str] = field(default_factory=lambda: _I18N_BLOCKING)

    @property
    def issues(self) -> list[I18nIssue]:
        """Back-compat alias — same list object as ``findings``."""
        return self.findings

    @issues.setter
    def issues(self, value: list[I18nIssue]) -> None:
        self.findings = value

    @property
    def error_count(self) -> int:
        """Back-compat: i18n only considers ERROR findings blocking."""
        return self.blocking_count

    @property
    def summary(self) -> str:
        """Per-type summary (overrides the base's per-severity one)."""
        if not self.findings:
            return "No issues"
        by_type: dict[str, int] = {}
        for issue in self.findings:
            by_type[issue.issue_type.value] = by_type.get(issue.issue_type.value, 0) + 1
        # Stable ordering so test snapshots don't flap.
        ordered = sorted(by_type.items(), key=lambda kv: kv[0])
        return ", ".join(f"{count} {t}" for t, count in ordered)


# Patterns for detecting hardcoded user-facing strings
_HARDCODED_PATTERNS = [
    # JSX/TSX: <Tag>Hardcoded text</Tag>
    re.compile(r">\s*([A-Z][a-z][^<>{}\n]{3,50})\s*<", re.MULTILINE),
    # Python: displayed strings in common functions
    re.compile(
        r'(?:flash|message|title|label|placeholder|error)\s*[=(]\s*["\']([A-Z][^"\']{3,60})["\']'
    ),
    # Flutter, SwiftUI, Jetpack Compose: Text("Hardcoded"), Text(text = "...")
    re.compile(r'\bText\(\s*(?:text\s*=\s*)?["\']([A-Z][^"\'\n$]{3,60})["\']'),
    # Android layouts and XAML (WPF, MAUI, Avalonia): attribute literals
    re.compile(
        r"\b(?:android:(?:text|hint|contentDescription)|Content|Text|Header|ToolTip)"
        r'\s*=\s*"([A-Z][^"@{]{3,60})"'
    ),
]


# Files whose strings are not shown to the person: tests, stories, fixtures.
_NOT_UI_FILE = re.compile(
    r"(?:^|/)(?:tests?|__tests__|__mocks__|spec|e2e|fixtures?|stories|storybook|mocks?)/|"
    r"\.(?:test|spec|stories|story|e2e|cy)\.\w+$|(?:^|/)test_[^/]+\.py$|_test\.(?:py|dart|go)$",
    re.I,
)
_TEST_CLASS = re.compile(r"[a-z0-9](?:Tests?|Spec)\.(?:cs|kt|java|swift)$")
# Lines that write a log or a debug message rather than an interface text.
_LOG_LINE = re.compile(
    r"\b(?:console|logger|logging|log|Log|_logger|Logger|Debug|Trace|NSLog|os_log|debugPrint|"
    r"print|println|printf|Timber)\s*[.(]",
)

_PLURAL_SUFFIX = re.compile(r"^(?P<base>.+)_(?P<cat>zero|one|two|few|many|other)$")


def is_ui_file(path: str) -> bool:
    """Whether strings in ``path`` may be shown to the person (not a test or story)."""
    normal = path.replace("\\", "/")
    return not (_NOT_UI_FILE.search(normal) or _TEST_CLASS.search(normal))


def _plural_not_needed(key: str, locale: str) -> bool:
    """A plural form ``locale`` does not use (``x_one`` in Japanese)."""
    match = _PLURAL_SUFFIX.match(key.rsplit(".", 1)[-1])
    if not match:
        return False
    needed = PLURAL_CATEGORIES.get(re.split(r"[-_]", locale.lower(), maxsplit=1)[0])
    return bool(needed) and match.group("cat") not in needed


def _plural_sibling(key: str, keys: set[str]) -> bool:
    """``x_many`` whose ``x_one`` / ``x_other`` the reference has."""
    match = _PLURAL_SUFFIX.match(key)
    if not match:
        return False
    base = match.group("base")
    return any(
        f"{base}_{cat}" in keys
        for cat in ("zero", "one", "two", "few", "many", "other")
    )


class I18nScanner(BaseScanner[I18nIssue, I18nReport]):
    """Scan a codebase for internationalisation issues.

    Per-file detection (``scan_file`` / ``scan_file_for_hardcoded``) is
    powered by ``BaseScanner``, so ``scan_files({path: content})`` works
    out of the box and swallows per-file exceptions. Locale-file
    comparison (``compare_locale_files``) and coverage computation
    (``compute_coverage``) are orthogonal to the per-file pattern and
    stay as standalone methods.

    Usage::

        scanner = I18nScanner()
        report = scanner.scan_file("src/App.tsx", tsx_content)
    """

    report_cls = I18nReport

    def __init__(self, reference_locale: str = "en") -> None:
        self._reference_locale = reference_locale

    def scan_file(self, file_path: str, content: str) -> I18nReport:
        """Scan one file and return an :class:`I18nReport`.

        Thin adapter around :meth:`scan_file_for_hardcoded` so we stay
        compatible with the ``BaseScanner`` contract while keeping the
        original method name for existing callers.
        """
        report = I18nReport(files_scanned=1)
        report.findings.extend(self.scan_file_for_hardcoded(file_path, content))
        return report

    def scan_file_for_hardcoded(self, file_path: str, content: str) -> list[I18nIssue]:
        """Detect hardcoded user-facing strings in a source file."""
        issues: list[I18nIssue] = []
        if not is_ui_file(file_path):
            return issues
        lines = content.splitlines()

        for i, line in enumerate(lines, 1):
            if _LOG_LINE.search(line):
                continue
            for pattern in _HARDCODED_PATTERNS:
                for match in pattern.finditer(line):
                    text = match.group(1).strip()
                    if len(text) > 3 and not _is_likely_code(text):
                        issues.append(
                            I18nIssue(
                                issue_type=I18nIssueType.HARDCODED_STRING,
                                severity=I18nSeverity.WARNING,
                                file=file_path,
                                line=i,
                                message=f'Hardcoded string: "{text[:50]}"',
                                suggestion="Extract to translation key",
                                text=text,
                            )
                        )
        return issues

    def compare_locale_files(
        self, reference: dict[str, Any], target: dict[str, Any], target_locale: str
    ) -> list[I18nIssue]:
        """Compare a target locale file against the reference."""
        issues: list[I18nIssue] = []
        ref_keys = _flatten_keys(reference)
        target_keys = _flatten_keys(target)

        for key in sorted(ref_keys):
            if key not in target_keys and not _plural_not_needed(key, target_locale):
                issues.append(
                    I18nIssue(
                        issue_type=I18nIssueType.MISSING_KEY,
                        severity=I18nSeverity.ERROR,
                        file=f"locale/{target_locale}.json",
                        key=key,
                        locale=target_locale,
                        message=f"Key '{key}' missing in {target_locale}",
                        suggestion=f"Add translation for '{key}' in {target_locale}",
                    )
                )

        for key in sorted(target_keys):
            if key not in ref_keys and not _plural_sibling(key, ref_keys):
                issues.append(
                    I18nIssue(
                        issue_type=I18nIssueType.UNUSED_KEY,
                        severity=I18nSeverity.INFO,
                        file=f"locale/{target_locale}.json",
                        key=key,
                        locale=target_locale,
                        message=f"Key '{key}' in {target_locale} not in reference locale",
                    )
                )

        return issues

    def compute_coverage(
        self, reference: dict[str, Any], locales: dict[str, dict[str, Any]]
    ) -> dict[str, float]:
        """Compute translation coverage per locale."""
        ref_keys = _flatten_keys(reference)
        if not ref_keys:
            return {}

        coverage: dict[str, float] = {}
        for locale_name, locale_data in locales.items():
            target_keys = _flatten_keys(locale_data)
            wanted = [k for k in ref_keys if not _plural_not_needed(k, locale_name)]
            matched = sum(1 for k in wanted if k in target_keys)
            coverage[locale_name] = matched / len(wanted) if wanted else 1.0
        return coverage


def _flatten_keys(data: dict[str, Any], prefix: str = "") -> set[str]:
    """Flatten a nested dict into dot-separated keys."""
    keys: set[str] = set()
    for k, v in data.items():
        full_key = f"{prefix}.{k}" if prefix else k
        if isinstance(v, dict):
            keys.update(_flatten_keys(v, full_key))
        else:
            keys.add(full_key)
    return keys


def _is_likely_code(text: str) -> bool:
    """Heuristic: is this string likely code rather than user-facing text?"""
    code_indicators = [
        "()",
        "=>",
        "->",
        "==",
        "!=",
        "{}",
        "[]",
        "//",
        "/*",
        "import ",
        "from ",
    ]
    return any(ind in text for ind in code_indicators)
