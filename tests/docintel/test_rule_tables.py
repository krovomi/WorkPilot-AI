"""Rule tables at their edges, and the tests drafted from them.

`test_docintel_specs.py` finds one table per layout and drafts it in every
language. This file covers what those leave out: pipe tables without their
outer pipes, grids whose first row is data, OCR rows that drift out of their
columns, values written with thousands separators or as yes/no, headers that
are numbers or keywords, NUnit and MSTest with decimals, and a project whose
languages or test libraries cannot be read.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from docintel import tables
from docintel.engines.base import OcrBox
from docintel.tables import (
    RuleTable,
    column_type,
    draft_for,
    drafts_for,
    identifiers,
    project_languages,
    tables_from_boxes,
    tables_from_text,
)

DECIMALS = RuleTable(
    headers=["Client", "Remise attendue"],
    rows=[["Gold", "12,5"], ["Standard", "0"]],
    caption="Remise",
)
INTEGERS = RuleTable(
    headers=["Pays", "Taux attendu"], rows=[["France", "20"], ["Allemagne", "19"]]
)


def csproj(root: Path, package: str) -> Path:
    (root / "Tests.csproj").write_text(
        f'<Project><ItemGroup><PackageReference Include="{package}" Version="3.0.0" />'
        "</ItemGroup></Project>",
        encoding="utf-8",
    )
    return root


class TestText:
    def test_a_pipe_table_without_its_outer_pipes(self):
        [table] = tables_from_text("a | b\n---|---\n1 | x\n2 | y\n")

        assert table.headers == ["a", "b"] and table.rows == [["1", "x"], ["2", "y"]]

    def test_a_pipe_table_of_one_row_or_long_cells_is_none(self):
        long = "x" * (tables.MAX_CELL_CHARS + 1)

        assert tables_from_text("| a | b |\n|---|---|\n| 1 | 2 |\n") == []
        assert (
            tables_from_text(f"| a | b |\n|---|---|\n| {long} | 2 |\n| 3 | 4 |") == []
        )

    def test_a_grid_whose_first_row_is_data_gets_column_names(self):
        grid = "+---+---+\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n+---+---+"

        [table] = tables_from_text(grid)

        assert table.headers == ["col1", "col2"] and len(table.rows) == 3

    @pytest.mark.parametrize(
        "grid",
        [
            "+---+\n| a | b |\n| 1 |\n| 2 | 3 |\n+---+",
            "+---+---+\n| a | b |\n| 1 | 2 |\n+---+---+",
            "+---+\n| a |\n| 1 |\n| 2 |\n+---+",
        ],
    )
    def test_a_ragged_short_or_single_column_grid_is_none(self, grid):
        assert tables_from_text(grid) == []


def box_rows(*rows: tuple[tuple[int, str], ...], start: int = 0) -> list[OcrBox]:
    return [
        OcrBox(text, x, line * 20, max(len(text), 1) * 8, 16, line=line)
        for line, cells in enumerate(rows, start=start)
        for x, text in cells
    ]


class TestBoxes:
    def test_no_box_no_table(self):
        assert tables_from_boxes([]) == []

    def test_a_row_out_of_its_columns_ends_the_table(self):
        boxes = box_rows(
            ((10, "Type"), (200, "Seuil")),
            ((10, "Gold"), (200, "100"), (300, " ")),
            ((10, "Std"), (200, "50")),
            ((90, "drift"), (500, "away")),
        )

        [table] = tables_from_boxes(boxes)

        assert table.rows == [["Gold", "100"], ["Std", "50"]]

    def test_two_cells_with_no_row_under_them_are_no_table(self):
        assert tables_from_boxes(box_rows(((10, "Total"), (200, "42")))) == []


class TestValues:
    def test_a_cell_that_is_only_a_currency_is_no_number(self):
        assert column_type(["€", "12"]) == "string"

    def test_thousands_separators_either_way(self):
        assert tables._number("1.000,50") == 1000.5
        assert tables._number("1,000.50") == 1000.5

    def test_yes_and_no_are_booleans_in_each_language(self):
        table = RuleTable(
            headers=["Member", "Free shipping"], rows=[["yes", "oui"], ["no", "non"]]
        )

        assert column_type(["yes", "no"]) == "bool"
        assert "(True, True)" in draft_for(table, "python").code
        assert "true, true" in draft_for(table, "java").code

    def test_headers_that_are_numbers_keywords_or_twice_the_same(self):
        table = RuleTable(headers=["2024", "Type", "Type"], rows=[["a", "b", "c"]])

        assert identifiers(table, "camel") == ["v2024", "type2", "type3"]


class TestDotnet:
    def test_nunit_carries_decimals_in_a_case_source(self, tmp_path):
        code = draft_for(DECIMALS, "csharp", csproj(tmp_path, "NUnit")).code

        assert "[TestCaseSource(nameof(Cases))]" in code
        assert 'new object[] { "Gold", 12.5m },' in code

    def test_mstest_rows_and_dynamic_data(self, tmp_path):
        root = csproj(tmp_path, "MSTest.TestFramework")

        rows = draft_for(INTEGERS, "csharp", root)
        dynamic = draft_for(DECIMALS, "csharp", root).code

        assert rows.framework == "mstest"
        assert '[DataRow("France", 20)]' in rows.code and "[TestClass]" in rows.code
        assert "[DynamicData(nameof(Cases))]" in dynamic
        assert "using System.Collections.Generic;" in dynamic

    def test_libraries_naming_no_known_framework_fall_back(self, tmp_path):
        draft = draft_for(INTEGERS, "csharp", csproj(tmp_path, "FluentAssertions"))

        assert draft.framework == "xunit"

    def test_libraries_that_cannot_be_read_fall_back(self, tmp_path, monkeypatch):
        import test_generation.libraries as libraries

        def broken(*_args):
            raise OSError("unreadable")

        monkeypatch.setattr(libraries, "resolve_selection", broken)

        assert draft_for(INTEGERS, "typescript", tmp_path).framework == "vitest"


class TestLanguages:
    def test_no_project_no_language(self):
        assert project_languages(None) == []

    def test_a_detector_that_fails_gives_none(self, tmp_path, monkeypatch):
        from project import stack_detector

        def broken(self):
            raise OSError("unreadable")

        monkeypatch.setattr(stack_detector.StackDetector, "detect_languages", broken)

        assert project_languages(tmp_path) == []

    def test_javascript_and_typescript_share_one_idiom(self, tmp_path):
        (tmp_path / "package.json").write_text("{}", encoding="utf-8")
        (tmp_path / "tsconfig.json").write_text("{}", encoding="utf-8")
        (tmp_path / "app.js").write_text("", encoding="utf-8")
        (tmp_path / "app.ts").write_text("", encoding="utf-8")

        assert project_languages(tmp_path) == ["typescript"]

    def test_a_language_without_an_idiom_has_no_draft(self):
        drafts = drafts_for(INTEGERS, ["elixir", "python"])

        assert [d.language for d in drafts] == ["python"]
