"""Business-rule tables in a document, and the parametrised test each one is.

A specification states its rules twice as often in a table as in prose: the
discount by customer type and amount, the tax rate by country, the status a
transition leads to. A table like that *is* a test — every row an example,
the last column the expected answer — and an agent that reads it as prose
writes one test for the first row, or none.

Two halves, both without a model:

- **Finding the grid.** In text: a Markdown pipe table, an ASCII grid, or
  columns aligned with spaces (the layout text `pdf.py` produces from a PDF's
  text layer, or Tesseract's own spacing). In an OCR result with word boxes:
  words grouped into cells by the horizontal gaps between them, and rows kept
  while their cells start where the header's do. Either way a grid needs a
  header and two rows, and no cell reading like a sentence — a paragraph split
  on double spaces is not a table.
- **Writing the test.** For every language the project is written in
  (`project.stack_detector`, the repository's one language detector), in the
  framework it already references (`test_generation.libraries`, the answer the
  test generator uses): xUnit `[Theory]`/`[InlineData]`, NUnit `[TestCase]`,
  MSTest `[DataRow]`, pytest `parametrize`, Vitest/Jest `it.each`, JUnit 5
  `@CsvSource`, Go and Rust table-driven tests, PHPUnit data providers, RSpec.
  The test calls a function the table cannot name; the draft says so rather
  than inventing one.

Nothing here writes into the project: the draft goes to the card and to the
coder's prompt, and the coder decides where it lives.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .engines.base import OcrBox

MIN_ROWS = 2
MAX_ROWS = 60
MAX_COLUMNS = 8
#: A cell longer than this reads as prose, not as a value.
MAX_CELL_CHARS = 60
MAX_TABLES = 12


@dataclass
class RuleTable:
    headers: list[str]
    rows: list[list[str]]
    #: The line above the table, when it reads like a title.
    caption: str = ""
    #: ``markdown``, ``grid``, ``aligned``, ``ocr-boxes``.
    source: str = ""
    #: 1-based page for a PDF, 0 otherwise.
    page: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, payload: dict) -> RuleTable:
        return cls(
            headers=[str(h) for h in payload.get("headers") or []],
            rows=[[str(c) for c in row] for row in payload.get("rows") or []],
            caption=str(payload.get("caption", "")),
            source=str(payload.get("source", "")),
            page=int(payload.get("page") or 0),
        )

    def to_markdown(self) -> str:
        def row(cells: list[str]) -> str:
            return "| " + " | ".join(c.replace("|", "\\|") for c in cells) + " |"

        lines = [row(self.headers), "|" + "---|" * len(self.headers)]
        lines += [row(r) for r in self.rows]
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Finding the grid in text
# ---------------------------------------------------------------------------

_PIPE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$")
_GRID_RULE = re.compile(r"^\s*\+[-=+]+\+\s*$")
_ALIGNED_SPLIT = re.compile(r"\t+| {2,}")
_PAGE_MARKER = re.compile(r"^\[page (\d+)\]$")


def _plausible(headers: list[str], rows: list[list[str]]) -> bool:
    if len(rows) < MIN_ROWS or not 2 <= len(headers) <= MAX_COLUMNS:
        return False
    cells = [c for c in headers] + [c for r in rows for c in r]
    if any(len(c) > MAX_CELL_CHARS for c in cells):
        return False
    filled = [c for c in cells if c.strip()]
    # A grid of mostly empty cells is a layout accident, not a table.
    return len(filled) >= 0.7 * len(cells)


def _all_numeric(cells: list[str]) -> bool:
    return all(_number(c) is not None for c in cells if c.strip()) and any(
        c.strip() for c in cells
    )


def _with_header(rows: list[list[str]]) -> tuple[list[str], list[list[str]]]:
    """The first row is the header unless it looks like data (all numbers)."""
    if rows and _all_numeric(rows[0]):
        return [f"col{i + 1}" for i in range(len(rows[0]))], rows
    return rows[0], rows[1:]


def _caption(lines: list[str], start: int) -> str:
    for index in range(start - 1, max(start - 3, -1), -1):
        text = lines[index].strip().strip("#*:_ ")
        if text and not _PAGE_MARKER.match(text):
            return text if len(text) <= 100 else ""
    return ""


def _pipe_cells(line: str) -> list[str]:
    body = line.strip()
    if body.startswith("|"):
        body = body[1:]
    if body.endswith("|"):
        body = body[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", body)]


def _markdown_tables(lines: list[str], pages: list[int]) -> list[RuleTable]:
    tables: list[RuleTable] = []
    index = 0
    while index < len(lines) - 2:
        if lines[index].count("|") >= 1 and _PIPE_SEPARATOR.match(lines[index + 1]):
            headers = _pipe_cells(lines[index])
            rows: list[list[str]] = []
            end = index + 2
            while end < len(lines) and lines[end].count("|") >= 1:
                cells = _pipe_cells(lines[end])
                rows.append((cells + [""] * len(headers))[: len(headers)])
                end += 1
            if _plausible(headers, rows):
                tables.append(
                    RuleTable(
                        headers,
                        rows[:MAX_ROWS],
                        _caption(lines, index),
                        "markdown",
                        pages[index],
                    )
                )
            index = end
            continue
        index += 1
    return tables


def _grid_tables(lines: list[str], pages: list[int]) -> list[RuleTable]:
    """`+---+---+` ASCII grids, the shape of a table pasted from a terminal."""
    tables: list[RuleTable] = []
    index = 0
    while index < len(lines):
        if not _GRID_RULE.match(lines[index]):
            index += 1
            continue
        start = index
        rows: list[list[str]] = []
        index += 1
        while index < len(lines) and (
            _GRID_RULE.match(lines[index]) or lines[index].strip().startswith("|")
        ):
            if not _GRID_RULE.match(lines[index]):
                rows.append(_pipe_cells(lines[index]))
            index += 1
        if len(rows) > MIN_ROWS and len({len(r) for r in rows}) == 1:
            headers, body = _with_header(rows)
            if _plausible(headers, body):
                tables.append(
                    RuleTable(
                        headers,
                        body[:MAX_ROWS],
                        _caption(lines, start),
                        "grid",
                        pages[start],
                    )
                )
    return tables


def _aligned_cells(line: str) -> list[tuple[int, str]]:
    """(column offset, text) for each run separated by a tab or 2+ spaces."""
    cells: list[tuple[int, str]] = []
    position = 0
    for part in _ALIGNED_SPLIT.split(line.rstrip()):
        offset = line.find(part, position) if part else position
        if part.strip():
            cells.append((offset, part.strip()))
        position = offset + len(part)
    return cells


def _aligned(first: list[int], other: list[int], tolerance: int) -> bool:
    """Whether a row's cells start where the header's do, one for one."""
    return len(first) == len(other) and all(
        abs(a - b) <= tolerance for a, b in zip(first, other, strict=True)
    )


def _aligned_tables(lines: list[str], pages: list[int]) -> list[RuleTable]:
    tables: list[RuleTable] = []
    index = 0
    while index < len(lines):
        header = _aligned_cells(lines[index])
        if len(header) < 2 or "|" in lines[index]:
            index += 1
            continue
        starts = [offset for offset, _ in header]
        rows: list[list[str]] = []
        end = index + 1
        while end < len(lines):
            cells = _aligned_cells(lines[end])
            if not _aligned(starts, [o for o, _ in cells], tolerance=3):
                break
            rows.append([text for _, text in cells])
            end += 1
        headers = [text for _, text in header]
        if _plausible(headers, rows):
            tables.append(
                RuleTable(
                    headers,
                    rows[:MAX_ROWS],
                    _caption(lines, index),
                    "aligned",
                    pages[index],
                )
            )
            index = end
            continue
        index += 1
    return tables


def _page_of_lines(lines: list[str]) -> list[int]:
    """The PDF page each line belongs to, from the `[page N]` markers."""
    pages: list[int] = []
    current = 0
    for line in lines:
        if match := _PAGE_MARKER.match(line.strip()):
            current = int(match.group(1))
        pages.append(current)
    return pages


def tables_from_text(text: str) -> list[RuleTable]:
    """Every table found in `text`, in reading order."""
    lines = text.splitlines()
    pages = _page_of_lines(lines)
    found = _markdown_tables(lines, pages) + _grid_tables(lines, pages)
    if not found:
        # Aligned columns only when nothing more explicit was found: a pipe
        # table's rows also line up, and would be found twice.
        found = _aligned_tables(lines, pages)
    return found[:MAX_TABLES]


# ---------------------------------------------------------------------------
# Finding the grid in OCR boxes
# ---------------------------------------------------------------------------


def _row_cells(words: list[OcrBox], gap: float) -> list[tuple[int, int, str]]:
    """(left, right, text) cells: words joined while the gap between them is small."""
    cells: list[tuple[int, int, str]] = []
    for box in sorted(words, key=lambda b: b.left):
        right = box.left + box.width
        if cells and box.left - cells[-1][1] <= gap:
            left, _, text = cells[-1]
            cells[-1] = (left, right, f"{text} {box.text}")
        else:
            cells.append((box.left, right, box.text))
    return cells


def tables_from_boxes(
    boxes: tuple[OcrBox, ...] | list[OcrBox], text: str = ""
) -> list[RuleTable]:
    """Tables in an OCR result, from where the words are rather than what they say.

    Tesseract's text loses the columns — a line of a table comes back as its
    words separated by single spaces — but its boxes keep them. A cell is a run
    of words closer than about two character widths; a row belongs to the
    table while its cells start under the header's.
    """
    if not boxes:
        return []
    widths = sorted(b.width / max(len(b.text), 1) for b in boxes if b.text.strip())
    char_width = widths[len(widths) // 2] if widths else 8.0
    gap = char_width * 2.2
    tolerance = char_width * 4

    by_line: dict[int, list[OcrBox]] = {}
    for box in boxes:
        if box.text.strip():
            by_line.setdefault(box.line, []).append(box)
    lines = text.splitlines()
    pages = _page_of_lines(lines) if lines else []

    tables: list[RuleTable] = []
    ordered = sorted(by_line)
    index = 0
    while index < len(ordered):
        header = _row_cells(by_line[ordered[index]], gap)
        if len(header) < 2:
            index += 1
            continue
        starts = [left for left, _, _ in header]
        rows: list[list[str]] = []
        end = index + 1
        while end < len(ordered) and ordered[end] == ordered[end - 1] + 1:
            cells = _row_cells(by_line[ordered[end]], gap)
            if not _aligned(starts, [left for left, _, _ in cells], int(tolerance)):
                break
            rows.append([t for _, _, t in cells])
            end += 1
        headers = [t for _, _, t in header]
        if _plausible(headers, rows):
            line = ordered[index]
            tables.append(
                RuleTable(
                    headers,
                    rows[:MAX_ROWS],
                    _caption(lines, line) if line < len(lines) else "",
                    "ocr-boxes",
                    pages[line] if line < len(pages) else 0,
                )
            )
            index = end
            continue
        index += 1
    return tables[:MAX_TABLES]


# ---------------------------------------------------------------------------
# Values
# ---------------------------------------------------------------------------

_NUMBER_NOISE = re.compile(r"[\s  €$£%¥]|CHF|EUR|USD", re.I)
_TRUE = {"true", "yes", "oui", "vrai", "y", "o", "x", "✓", "✔"}
_FALSE = {"false", "no", "non", "faux", "n", "-", "✗", "✘"}


def _number(cell: str) -> float | None:
    raw = _NUMBER_NOISE.sub("", cell.strip())
    if not raw:
        return None
    if re.fullmatch(r"-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?", raw):
        # 1.000,50 / 1,000.50: the last separator is the decimal one.
        head, _, tail = raw.rpartition("," if raw.rfind(",") > raw.rfind(".") else ".")
        raw = re.sub(r"[.,]", "", head) + "." + tail
    raw = raw.replace(",", ".")
    try:
        return float(raw)
    except ValueError:
        return None


def column_type(cells: list[str]) -> str:
    """``int``, ``decimal``, ``bool`` or ``string`` — for every cell of a column."""
    values = [c.strip() for c in cells]
    if values and all(v.lower() in _TRUE | _FALSE for v in values):
        return "bool"
    numbers = [_number(v) for v in values]
    if values and all(n is not None for n in numbers):
        integral = all(
            float(n).is_integer() and not re.search(r"[.,]\d", v)
            for n, v in zip(numbers, values, strict=True)
        )
        return "int" if integral else "decimal"
    return "string"


_EXPECTED_HEADER = re.compile(
    r"expected|result|résultat|resultat|attendu|output|sortie|then|alors|"
    r"=>|→|outcome|réponse|decision|décision",
    re.I,
)


def expected_column(table: RuleTable) -> int:
    for index, header in enumerate(table.headers):
        if _EXPECTED_HEADER.search(header):
            return index
    return len(table.headers) - 1


def _ascii_words(text: str) -> list[str]:
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return [w for w in re.split(r"[^A-Za-z0-9]+", folded) if w]


def identifiers(table: RuleTable, style: str) -> list[str]:
    """One parameter name per column, unique, valid in every language here."""
    names: list[str] = []
    for index, header in enumerate(table.headers):
        words = _ascii_words(header) or [f"col{index + 1}"]
        if style == "snake":
            name = "_".join(w.lower() for w in words)
        else:
            name = words[0].lower() + "".join(
                w[:1].upper() + w[1:].lower() for w in words[1:]
            )
        if name[0].isdigit():
            name = f"v{name}"
        if name in names or name in _RESERVED:
            name = f"{name}{index + 1}"
        names.append(name)
    return names


_RESERVED = {
    "class", "def", "for", "if", "in", "is", "new", "return", "static", "string",
    "int", "var", "fn", "func", "type", "case", "default", "object", "end",
    "then", "else", "and", "or", "not", "match", "let", "const", "true", "false",
    "decimal", "double", "bool", "list", "map", "import", "package", "struct",
}  # fmt: skip


def _pascal(text: str) -> str:
    return "".join(w[:1].upper() + w[1:].lower() for w in _ascii_words(text))


def rule_name(table: RuleTable) -> str:
    """`Remise selon le type de client` -> `RemiseSelonLeTypeDeClient`."""
    return _pascal(table.caption)[:60] or "BusinessRule"


# ---------------------------------------------------------------------------
# The parametrised test, per language
# ---------------------------------------------------------------------------


@dataclass
class TestDraft:
    #: ``csharp``, ``python``, ``typescript``, ``java``, ``kotlin``, ``go``,
    #: ``rust``, ``php``, ``ruby``.
    language: str
    #: ``xunit``, ``nunit``, ``mstest``, ``pytest``, ``vitest``, ``jest``,
    #: ``junit5``, ``go-test``, ``rust-test``, ``phpunit``, ``rspec``.
    framework: str
    code: str
    notes: list[str] = field(default_factory=list)

    __test__ = False

    def to_dict(self) -> dict:
        return asdict(self)


def _string_literal(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _literal(cell: str, kind: str, language: str) -> str:
    value = cell.strip()
    if kind == "bool":
        truth = value.lower() in _TRUE
        if language == "python":
            return "True" if truth else "False"
        return "true" if truth else "false"
    if kind in ("int", "decimal"):
        number = _number(value)
        text = (
            str(int(number))
            if kind == "int" and number is not None
            else repr(number if number is not None else 0.0)
        )
        if kind == "decimal" and language == "csharp":
            return f"{text}m"
        if kind == "decimal" and language in ("kotlin", "java"):
            return text
        return text
    if language == "php":
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if language == "ruby":
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    return _string_literal(value)


_TYPES = {
    "csharp": {"int": "int", "decimal": "decimal", "bool": "bool", "string": "string"},
    "java": {"int": "int", "decimal": "double", "bool": "boolean", "string": "String"},
    "kotlin": {"int": "Int", "decimal": "Double", "bool": "Boolean", "string": "String"},
    "go": {"int": "int", "decimal": "float64", "bool": "bool", "string": "string"},
    "rust": {"int": "i64", "decimal": "f64", "bool": "bool", "string": "&str"},
    "typescript": {"int": "number", "decimal": "number", "bool": "boolean", "string": "string"},
    "php": {"int": "int", "decimal": "float", "bool": "bool", "string": "string"},
    "python": {"int": "int", "decimal": "float", "bool": "bool", "string": "str"},
}  # fmt: skip


class _Shape:
    """The table seen by a template: names, types, rows as literals."""

    def __init__(self, table: RuleTable, language: str, style: str) -> None:
        self.table = table
        self.language = language
        self.names = identifiers(table, style)
        self.kinds = [
            column_type([row[i] if i < len(row) else "" for row in table.rows])
            for i in range(len(table.headers))
        ]
        self.expected = expected_column(table)
        self.inputs = [i for i in range(len(self.names)) if i != self.expected]
        self.rows = [
            [
                _literal(row[i] if i < len(row) else "", self.kinds[i], language)
                for i in range(len(self.names))
            ]
            for row in table.rows
        ]
        self.rule = rule_name(table)

    def type_of(self, index: int) -> str:
        return _TYPES[self.language][self.kinds[index]]

    def call(self, function: str, separator: str = ", ") -> str:
        return f"{function}({separator.join(self.names[i] for i in self.inputs)})"

    @property
    def expected_name(self) -> str:
        return self.names[self.expected]


_TODO = "TODO: replace {name} with the rule this table specifies"


def _csharp(shape: _Shape, framework: str) -> str:
    rule = shape.rule
    params = ", ".join(f"{shape.type_of(i)} {n}" for i, n in enumerate(shape.names))
    act = f"var actual = {shape.call('RuleUnderTest')};"
    decimal = "decimal" in shape.kinds
    lines = [f"// {_TODO.format(name='RuleUnderTest')}", ""]
    if framework == "nunit":
        lines += ["using NUnit.Framework;", "", f"public class {rule}Tests", "{"]
        if decimal:
            lines += ["    private static readonly object[] Cases =", "    {"]
            lines += [f"        new object[] {{ {', '.join(r)} }}," for r in shape.rows]
            lines += ["    };", "", "    [TestCaseSource(nameof(Cases))]"]
        else:
            lines += [f"    [TestCase({', '.join(r)})]" for r in shape.rows]
        lines += [
            f"    public void {rule}_matches_the_rule_table({params})",
            "    {",
            f"        {act}",
            f"        Assert.That(actual, Is.EqualTo({shape.expected_name}));",
            "    }",
            "}",
        ]
        return "\n".join(lines) + "\n"
    if framework == "mstest":
        lines += [
            *(["using System.Collections.Generic;"] if decimal else []),
            "using Microsoft.VisualStudio.TestTools.UnitTesting;",
            "",
            "[TestClass]",
            f"public class {rule}Tests",
            "{",
        ]
        if decimal:
            lines += [
                "    public static IEnumerable<object[]> Cases => new[]",
                "    {",
                *[f"        new object[] {{ {', '.join(r)} }}," for r in shape.rows],
                "    };",
                "",
                "    [DataTestMethod]",
                "    [DynamicData(nameof(Cases))]",
            ]
        else:
            lines += ["    [DataTestMethod]"]
            lines += [f"    [DataRow({', '.join(r)})]" for r in shape.rows]
        lines += [
            f"    public void {rule}_matches_the_rule_table({params})",
            "    {",
            f"        {act}",
            f"        Assert.AreEqual({shape.expected_name}, actual);",
            "    }",
            "}",
        ]
        return "\n".join(lines) + "\n"
    # xUnit — the default of a .NET project that references nothing yet.
    lines += ["using Xunit;", "", f"public class {rule}Tests", "{"]
    if decimal:
        # Attribute arguments cannot be decimal: TheoryData carries them typed.
        types = ", ".join(shape.type_of(i) for i in range(len(shape.names)))
        lines += [
            f"    public static TheoryData<{types}> Cases => new()",
            "    {",
            *[f"        {{ {', '.join(r)} }}," for r in shape.rows],
            "    };",
            "",
            "    [Theory]",
            "    [MemberData(nameof(Cases))]",
        ]
    else:
        lines += ["    [Theory]"]
        lines += [f"    [InlineData({', '.join(r)})]" for r in shape.rows]
    lines += [
        f"    public void {rule}_matches_the_rule_table({params})",
        "    {",
        f"        {act}",
        f"        Assert.Equal({shape.expected_name}, actual);",
        "    }",
        "}",
    ]
    return "\n".join(lines) + "\n"


def _python(shape: _Shape) -> str:
    names = ", ".join(shape.names)
    rows = "\n".join(f"        ({', '.join(r)})," for r in shape.rows)
    function = re.sub(r"(?<!^)(?=[A-Z])", "_", shape.rule).lower()
    return (
        "import pytest\n\n"
        f"# {_TODO.format(name='rule_under_test')}\n\n\n"
        "@pytest.mark.parametrize(\n"
        f'    "{names}",\n'
        "    [\n"
        f"{rows}\n"
        "    ],\n"
        ")\n"
        f"def test_{function}_matches_the_rule_table({names}):\n"
        f"    assert {shape.call('rule_under_test')} == {shape.expected_name}\n"
    )


def _typescript(shape: _Shape, framework: str) -> str:
    fields = ", ".join(f"{n}: {shape.type_of(i)}" for i, n in enumerate(shape.names))
    rows = "\n".join(
        "\t{ "
        + ", ".join(f"{n}: {v}" for n, v in zip(shape.names, r, strict=True))
        + " },"
        for r in shape.rows
    )
    imports = (
        'import { describe, expect, it } from "vitest";\n'
        if framework == "vitest"
        else ""
    )
    title = shape.table.caption or shape.rule
    return (
        f"{imports}// {_TODO.format(name='ruleUnderTest')}\n\n"
        f"const cases: Array<{{ {fields} }}> = [\n{rows}\n];\n\n"
        f"describe({_string_literal(title)}, () => {{\n"
        f'\tit.each(cases)("matches row %#", ({{ {", ".join(shape.names)} }}) => {{\n'
        f"\t\texpect({shape.call('ruleUnderTest')}).toEqual({shape.expected_name});\n"
        "\t});\n"
        "});\n"
    )


def _csv_row(shape: _Shape, row_index: int) -> str:
    """One `@CsvSource` line: numbers and booleans normalised, text quoted when
    it carries the separator. `12,5` in a French table is a decimal, and JUnit's
    converter reads `12.5`."""
    cells: list[str] = []
    for column, literal in enumerate(shape.rows[row_index]):
        if shape.kinds[column] != "string":
            cells.append(literal)
            continue
        value = shape.table.rows[row_index][column].strip()
        cells.append(
            "'" + value.replace("'", "''") + "'"
            if ("," in value or "'" in value or not value)
            else value
        )
    return _string_literal(", ".join(cells))


def _java(shape: _Shape) -> str:
    params = ", ".join(f"{shape.type_of(i)} {n}" for i, n in enumerate(shape.names))
    rows = ",\n".join(
        "        " + _csv_row(shape, index) for index in range(len(shape.rows))
    )
    return (
        "import static org.junit.jupiter.api.Assertions.assertEquals;\n\n"
        "import org.junit.jupiter.params.ParameterizedTest;\n"
        "import org.junit.jupiter.params.provider.CsvSource;\n\n"
        f"// {_TODO.format(name='ruleUnderTest')}\n"
        f"class {shape.rule}Test {{\n\n"
        "    @ParameterizedTest\n"
        "    @CsvSource({\n"
        f"{rows}\n"
        "    })\n"
        f"    void matchesTheRuleTable({params}) {{\n"
        f"        assertEquals({shape.expected_name}, {shape.call('ruleUnderTest')});\n"
        "    }\n"
        "}\n"
    )


def _kotlin(shape: _Shape) -> str:
    params = ", ".join(f"{n}: {shape.type_of(i)}" for i, n in enumerate(shape.names))
    rows = ",\n".join(
        "        " + _csv_row(shape, index) for index in range(len(shape.rows))
    )
    return (
        "import org.junit.jupiter.api.Assertions.assertEquals\n"
        "import org.junit.jupiter.params.ParameterizedTest\n"
        "import org.junit.jupiter.params.provider.CsvSource\n\n"
        f"// {_TODO.format(name='ruleUnderTest')}\n"
        f"class {shape.rule}Test {{\n\n"
        "    @ParameterizedTest\n"
        "    @CsvSource(\n"
        f"{rows}\n"
        "    )\n"
        f"    fun matchesTheRuleTable({params}) {{\n"
        f"        assertEquals({shape.expected_name}, {shape.call('ruleUnderTest')})\n"
        "    }\n"
        "}\n"
    )


def _go(shape: _Shape) -> str:
    fields = "\n".join(f"\t\t{n} {shape.type_of(i)}" for i, n in enumerate(shape.names))
    rows = "\n".join("\t\t{" + ", ".join(r) + "}," for r in shape.rows)
    call = (
        "ruleUnderTest(" + ", ".join(f"tc.{shape.names[i]}" for i in shape.inputs) + ")"
    )
    return (
        'import "testing"\n\n'
        f"// {_TODO.format(name='ruleUnderTest')}\n"
        f"func Test{shape.rule}(t *testing.T) {{\n"
        "\tcases := []struct {\n"
        f"{fields}\n"
        "\t}{\n"
        f"{rows}\n"
        "\t}\n"
        "\tfor _, tc := range cases {\n"
        f"\t\tif got := {call}; got != tc.{shape.expected_name} {{\n"
        f'\t\t\tt.Errorf("{call.replace(chr(34), "")} = %v, want %v", got, tc.{shape.expected_name})\n'
        "\t\t}\n"
        "\t}\n"
        "}\n"
    )


def _rust(shape: _Shape) -> str:
    types = ", ".join(shape.type_of(i) for i in range(len(shape.names)))
    rows = "\n".join("            (" + ", ".join(r) + ")," for r in shape.rows)
    function = re.sub(r"(?<!^)(?=[A-Z])", "_", shape.rule).lower()
    return (
        "#[cfg(test)]\n"
        "mod tests {\n"
        "    use super::*;\n\n"
        f"    // {_TODO.format(name='rule_under_test')}\n"
        "    #[test]\n"
        f"    fn {function}_matches_the_rule_table() {{\n"
        f"        let cases: &[({types})] = &[\n"
        f"{rows}\n"
        "        ];\n"
        f"        for &({', '.join(shape.names)}) in cases {{\n"
        f"            assert_eq!({shape.call('rule_under_test')}, {shape.expected_name});\n"
        "        }\n"
        "    }\n"
        "}\n"
    )


def _php(shape: _Shape) -> str:
    params = ", ".join(f"{shape.type_of(i)} ${n}" for i, n in enumerate(shape.names))
    rows = "\n".join("            [" + ", ".join(r) + "]," for r in shape.rows)
    call = (
        "ruleUnderTest(" + ", ".join(f"${shape.names[i]}" for i in shape.inputs) + ")"
    )
    return (
        "<?php\n\n"
        "use PHPUnit\\Framework\\Attributes\\DataProvider;\n"
        "use PHPUnit\\Framework\\TestCase;\n\n"
        f"// {_TODO.format(name='ruleUnderTest')}\n"
        f"final class {shape.rule}Test extends TestCase\n"
        "{\n"
        "    public static function cases(): array\n"
        "    {\n"
        "        return [\n"
        f"{rows}\n"
        "        ];\n"
        "    }\n\n"
        "    #[DataProvider('cases')]\n"
        f"    public function testMatchesTheRuleTable({params}): void\n"
        "    {\n"
        f"        $this->assertSame(${shape.expected_name}, {call});\n"
        "    }\n"
        "}\n"
    )


def _ruby(shape: _Shape) -> str:
    rows = "\n".join("    [" + ", ".join(r) + "]," for r in shape.rows)
    call = "rule_under_test(" + ", ".join(shape.names[i] for i in shape.inputs) + ")"
    title = shape.table.caption or shape.rule
    return (
        f"# {_TODO.format(name='rule_under_test')}\n"
        f"RSpec.describe {_string_literal(title)} do\n"
        "  [\n"
        f"{rows}\n"
        f"  ].each do |{', '.join(shape.names)}|\n"
        f'    it "matches the row #{{[{", ".join(shape.names)}].inspect}}" do\n'
        f"      expect({call}).to eq({shape.expected_name})\n"
        "    end\n"
        "  end\n"
        "end\n"
    )


#: Language (as `StackDetector` names it) -> the language of the draft.
_LANGUAGES = {
    "csharp": "csharp",
    "python": "python",
    "typescript": "typescript",
    "javascript": "typescript",
    "java": "java",
    "kotlin": "kotlin",
    "go": "go",
    "rust": "rust",
    "php": "php",
    "ruby": "ruby",
}
#: The framework of a language whose test libraries `test_generation` does
#: not catalogue: the one its toolchain ships with, or the ecosystem's default.
_FIXED_FRAMEWORK = {
    "go": "go-test",
    "rust": "rust-test",
    "php": "phpunit",
    "ruby": "rspec",
    "kotlin": "junit5",
}


def _framework(project_dir: Path | None, language: str) -> str:
    """The framework the project already references, via `test_generation`."""
    if language in _FIXED_FRAMEWORK:
        return _FIXED_FRAMEWORK[language]
    wanted = {
        "csharp": ("xunit", "nunit", "mstest"),
        "typescript": ("vitest", "jest"),
        "python": ("pytest",),
        "java": ("junit5",),
    }[language]
    if project_dir is not None:
        try:
            from test_generation.libraries import resolve_selection

            ids = resolve_selection(project_dir, language).ids()
            for candidate in wanted:
                if candidate in ids:
                    return candidate
        except Exception:  # noqa: BLE001 - a guess is still a useful draft
            pass
    return wanted[0]


def draft_for(
    table: RuleTable, language: str, project_dir: Path | None = None
) -> TestDraft | None:
    """The parametrised test for `table`, in `language`, or None."""
    target = _LANGUAGES.get(language)
    if target is None or not table.rows:
        return None
    framework = _framework(project_dir, target)
    style = "snake" if target in ("python", "rust", "ruby") else "camel"
    shape = _Shape(table, target, style)
    notes = [
        "The table does not name the function it specifies: replace the "
        "placeholder call with the rule under test.",
    ]
    if target == "csharp":
        code = _csharp(shape, framework)
    elif target == "python":
        code = _python(shape)
    elif target == "typescript":
        code = _typescript(shape, framework)
    elif target == "java":
        code = _java(shape)
    elif target == "kotlin":
        code = _kotlin(shape)
    elif target == "go":
        code = _go(shape)
    elif target == "rust":
        code = _rust(shape)
    elif target == "php":
        code = _php(shape)
    else:
        code = _ruby(shape)
    return TestDraft(language=target, framework=framework, code=code, notes=notes)


def project_languages(project_dir: Path | None) -> list[str]:
    """The project's languages that have a test idiom here, primary first.

    `project.stack_detector.StackDetector` is the repository's language
    detector; asking it rather than re-reading manifests keeps "what is this
    project written in" one answer.
    """
    if project_dir is None:
        return []
    try:
        from project.stack_detector import StackDetector

        detector = StackDetector(Path(project_dir))
        detector.detect_languages()
        detected = list(detector.stack.languages)
    except Exception:  # noqa: BLE001 - no language is a draft-less answer
        return []
    seen: list[str] = []
    for language in detected:
        target = _LANGUAGES.get(language)
        if target and target not in seen:
            seen.append(target)
    return seen


def drafts_for(
    table: RuleTable, languages: list[str], project_dir: Path | None = None
) -> list[TestDraft]:
    """One draft per language of the project, at most three."""
    drafts: list[TestDraft] = []
    for language in languages[:3]:
        if draft := draft_for(table, language, project_dir):
            drafts.append(draft)
    return drafts
