"""
Documentation Drift Detector — Detect when docs diverge from code.

Compares README, API docs, inline docstrings, and configuration
examples against the actual codebase to flag stale documentation.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class DriftType(str, Enum):
    STALE_REFERENCE = "stale_reference"
    MISSING_FUNCTION = "missing_function"
    OUTDATED_EXAMPLE = "outdated_example"
    MISSING_DOCS = "missing_docs"
    CONFIG_MISMATCH = "config_mismatch"


class DriftSeverity(str, Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


@dataclass
class DriftIssue:
    """A single documentation drift issue."""

    drift_type: DriftType
    severity: DriftSeverity
    doc_file: str
    doc_line: int = 0
    message: str = ""
    referenced_symbol: str = ""
    suggestion: str = ""


@dataclass
class DriftReport:
    """Documentation drift analysis report."""

    issues: list[DriftIssue] = field(default_factory=list)
    docs_scanned: int = 0
    source_files_scanned: int = 0

    @property
    def high_count(self) -> int:
        return sum(1 for i in self.issues if i.severity == DriftSeverity.HIGH)

    @property
    def summary(self) -> str:
        by_type = {}
        for issue in self.issues:
            by_type[issue.drift_type.value] = by_type.get(issue.drift_type.value, 0) + 1
        parts = [f"{count} {t}" for t, count in by_type.items()]
        return ", ".join(parts) or "No drift detected"


# Patterns to extract code references from documentation
_CODE_REF_PATTERN = re.compile(r"`([a-zA-Z_]\w*(?:\.\w+)*)\(`")
_FILE_REF_PATTERN = re.compile(r"`([a-zA-Z0-9_/\\.-]+\.\w{1,5})`")
_IMPORT_REF_PATTERN = re.compile(r"(?:from|import)\s+`?([a-zA-Z_]\w*(?:\.\w+)*)`?")


class DriftScanner:
    """Scan documentation for drift from the actual codebase.

    Usage::

        scanner = DriftScanner()
        report = scanner.scan(doc_files, source_symbols)
    """

    def scan(
        self,
        doc_files: dict[str, str],
        source_symbols: set[str],
        source_files: set[str] | None = None,
        *,
        code_words: set[str] | None = None,
        file_exists: Callable[[str, str], bool] | None = None,
    ) -> DriftReport:
        """Scan doc files for references to symbols/files that no longer exist.

        ``code_words``: every identifier written anywhere in the code. A name
        the docs call that the code still mentions (a library function the
        project uses, a method declared in a way the symbol index misses) is
        not reported: only names the code no longer contains at all are.
        ``file_exists(doc_path, ref)``: how a cited path is resolved (next to
        the document, from the project root...); without it the cited path
        must be one of ``source_files``.
        """
        report = DriftReport(
            docs_scanned=len(doc_files),
            source_files_scanned=len(source_files or set()),
        )

        for doc_path, content in doc_files.items():
            report.issues.extend(
                self._check_code_references(
                    doc_path, content, source_symbols, code_words or set()
                )
            )
            if source_files or file_exists:
                report.issues.extend(
                    self._check_file_references(
                        doc_path, content, source_files or set(), file_exists
                    )
                )

        return report

    def _check_code_references(
        self,
        doc_path: str,
        content: str,
        symbols: set[str],
        code_words: set[str] | None = None,
    ) -> list[DriftIssue]:
        issues: list[DriftIssue] = []
        lines = content.splitlines()
        words = code_words or set()

        for i, line in enumerate(lines, 1):
            for match in _CODE_REF_PATTERN.finditer(line):
                ref = match.group(1)
                last = ref.rsplit(".", 1)[-1]
                if (
                    ref in symbols
                    or last in symbols
                    or last in words
                    or _is_common_builtin(ref)
                    or _is_common_builtin(last)
                ):
                    continue
                issues.append(
                    DriftIssue(
                        drift_type=DriftType.MISSING_FUNCTION,
                        severity=DriftSeverity.HIGH,
                        doc_file=doc_path,
                        doc_line=i,
                        referenced_symbol=ref,
                        message=f"Function '{ref}' referenced in docs not found in codebase",
                        suggestion=f"Update or remove reference to '{ref}'",
                    )
                )

        return issues

    def _check_file_references(
        self,
        doc_path: str,
        content: str,
        files: set[str],
        file_exists: Callable[[str, str], bool] | None = None,
    ) -> list[DriftIssue]:
        issues: list[DriftIssue] = []
        lines = content.splitlines()

        for i, line in enumerate(lines, 1):
            for match in _FILE_REF_PATTERN.finditer(line):
                ref = match.group(1)
                if _is_url_or_extension(ref) or _is_not_a_project_path(ref):
                    continue
                # Normalise path separators
                normalised = ref.replace("\\", "/")
                found = (
                    file_exists(doc_path, normalised)
                    if file_exists
                    else normalised in files
                )
                if not found:
                    issues.append(
                        DriftIssue(
                            drift_type=DriftType.STALE_REFERENCE,
                            severity=DriftSeverity.MEDIUM,
                            doc_file=doc_path,
                            doc_line=i,
                            referenced_symbol=ref,
                            message=f"File '{ref}' referenced in docs not found in codebase",
                            suggestion=f"Update the file reference '{ref}' or remove it",
                        )
                    )

        return issues


def _is_common_builtin(name: str) -> bool:
    builtins = {
        "print",
        "len",
        "str",
        "int",
        "float",
        "list",
        "dict",
        "set",
        "True",
        "False",
        "None",
        "self",
        "cls",
        "console",
        "log",
        "require",
        "import",
        "export",
        "return",
        "async",
        "await",
    }
    return name in builtins


def _is_url_or_extension(ref: str) -> bool:
    return ref.startswith("http") or ref.startswith(".") or "/" not in ref


# Folders whose files are generated or installed, never written by hand: a
# README citing dist/app.js or node_modules/x is not stale when the folder
# is absent from a clean checkout.
_GENERATED_ROOTS = frozenset(
    {
        "dist", "build", "out", "node_modules", "target", "bin", "obj", "coverage",
        ".next", ".nuxt", "vendor", "Pods", ".venv", "venv", "__pycache__",
    }
)  # fmt: skip


def _is_not_a_project_path(ref: str) -> bool:
    """Absolute, home, glob or generated paths: not something to check."""
    normalised = ref.replace("\\", "/")
    first = normalised.lstrip("./").split("/", 1)[0]
    return (
        normalised.startswith(("/", "~"))
        or "*" in normalised
        or first in _GENERATED_ROOTS
    )
