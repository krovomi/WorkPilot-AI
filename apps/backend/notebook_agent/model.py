"""Data model of a parsed notebook, shared by the Jupyter handler and the text formats."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class CellType(str, Enum):
    CODE = "code"
    MARKDOWN = "markdown"
    RAW = "raw"


class NotebookIssueType(str, Enum):
    STALE_OUTPUT = "stale_output"
    OUT_OF_ORDER = "out_of_order"
    MISSING_IMPORT = "missing_import"
    EMPTY_CELL = "empty_cell"
    LONG_CELL = "long_cell"
    NO_MARKDOWN = "no_markdown"
    SENSITIVE_OUTPUT = "sensitive_output"
    USED_BEFORE_DEFINED = "used_before_defined"
    UNDEFINED_NAME = "undefined_name"
    HIDDEN_STATE = "hidden_state"
    IMPLICIT_GLOBAL = "implicit_global"
    SHARED_MUTATION = "shared_mutation"
    DUPLICATE_CODE = "duplicate_code"


@dataclass
class NotebookCell:
    """A single notebook cell."""

    index: int
    cell_type: CellType
    source: str
    execution_count: int | None = None
    outputs: list[dict[str, Any]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class NotebookIssue:
    """An issue detected in a notebook."""

    issue_type: NotebookIssueType
    cell_index: int
    message: str
    severity: str = "warning"
    suggestion: str = ""


@dataclass
class ParsedNotebook:
    """Parsed representation of a Jupyter notebook."""

    path: str = ""
    cells: list[NotebookCell] = field(default_factory=list)
    kernel: str = ""
    language: str = ""
    nbformat: int = 4
    metadata: dict[str, Any] = field(default_factory=dict)
    issues: list[NotebookIssue] = field(default_factory=list)

    @property
    def code_cells(self) -> list[NotebookCell]:
        return [c for c in self.cells if c.cell_type == CellType.CODE]

    @property
    def markdown_cells(self) -> list[NotebookCell]:
        return [c for c in self.cells if c.cell_type == CellType.MARKDOWN]
