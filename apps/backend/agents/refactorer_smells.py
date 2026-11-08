"""The smells a refactoring scan reports, shared by every detector.

``refactorer`` (Python, read with ``ast``) and ``refactorer_polyglot`` (the
other stacks) both produce these; keeping them here lets the polyglot
detector depend on the model without importing the agent, so the two
modules never import each other.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class SmellType(str, Enum):
    """Types of code smells detected."""

    LONG_METHOD = "long_method"
    GOD_CLASS = "god_class"
    DUPLICATE_CODE = "duplicate_code"
    LONG_PARAMETER_LIST = "long_parameter_list"
    DEAD_CODE = "dead_code"
    DEEP_NESTING = "deep_nesting"
    COMPLEX_CONDITIONAL = "complex_conditional"
    MAGIC_NUMBER = "magic_number"
    MISSING_DOCSTRING = "missing_docstring"
    TOO_MANY_RETURNS = "too_many_returns"
    LARGE_FILE = "large_file"
    UNUSED_IMPORT = "unused_import"


class SmellSeverity(str, Enum):
    """Severity level of a code smell."""

    INFO = "info"
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class CodeSmell:
    """A detected code smell.

    Attributes:
        smell_type: Type of smell.
        severity: Severity level.
        file_path: File where the smell was found.
        line_start: Starting line number.
        line_end: Ending line number.
        message: Human-readable description.
        symbol_name: Name of the offending symbol (function, class, etc.).
        metric_value: The measured metric value (e.g. line count).
        threshold: The threshold that was exceeded.
    """

    smell_type: SmellType
    severity: SmellSeverity
    file_path: str
    line_start: int = 0
    line_end: int = 0
    message: str = ""
    symbol_name: str = ""
    metric_value: int = 0
    threshold: int = 0

    def to_dict(self) -> dict:
        return {
            "smell_type": self.smell_type.value,
            "severity": self.severity.value,
            "file_path": self.file_path,
            "line_start": self.line_start,
            "line_end": self.line_end,
            "message": self.message,
            "symbol_name": self.symbol_name,
            "metric_value": self.metric_value,
            "threshold": self.threshold,
        }
