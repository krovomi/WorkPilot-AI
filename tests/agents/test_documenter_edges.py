"""What the documentation agent makes of files it cannot read as code."""

from __future__ import annotations

from pathlib import Path

from agents.documenter import (
    DiagramType,
    DocAnalyzer,
    DocFormat,
    DocGenerator,
    DocumentationAgent,
    SymbolDoc,
)


def test_a_file_in_no_known_language_or_that_does_not_parse_has_no_symbols() -> None:
    analyzer = DocAnalyzer()

    assert analyzer.analyze_polyglot("whatever", "notes.unknownext") == []
    assert analyzer.analyze_source("def broken(:\n", "broken.py") == []


def test_a_folder_that_is_gone_is_an_empty_module(tmp_path: Path) -> None:
    info = DocAnalyzer().analyze_directory(str(tmp_path / "gone"))

    assert (info.name, info.files, info.dependencies) == ("gone", [], [])


def test_a_module_is_read_around_the_files_it_cannot_parse(tmp_path: Path) -> None:
    pkg = tmp_path / "shop"
    pkg.mkdir()
    (pkg / "cart.py").write_text(
        "import os.path\nimport json\nfrom decimal import Decimal\n"
        "from . import sibling\nimport os\n\n"
        "class Cart:\n    pass\n\n\ndef total() -> Decimal:\n    return Decimal(0)\n",
        encoding="utf-8",
    )
    (pkg / "broken.py").write_text("def broken(:\n", encoding="utf-8")
    (pkg / "latin.py").write_bytes("# caf\xe9\nimport zlib\n".encode("latin-1"))
    (pkg / "view.ts").write_text("export function render() {}\n", encoding="utf-8")
    (pkg / "__init__.py").write_text('"""broken docstring\n', encoding="utf-8")
    (pkg / "api").mkdir()
    (pkg / "api" / "routes.ts").write_text("export {}\n", encoding="utf-8")
    (pkg / "assets").mkdir()

    info = DocAnalyzer().analyze_directory(str(pkg))

    assert "Cart" in info.classes and "total" in info.functions
    assert "render" in info.functions
    # Imports come from the files that parse; the rest are skipped.
    assert info.dependencies == ["os", "json", "decimal"]
    assert info.description == ""
    assert info.submodules == ["api"]

    readme = DocGenerator().generate_readme(info)
    assert "## Dependencies" in readme
    assert "- `decimal`" in readme


def test_a_python_format_without_its_own_template_is_written_google_style() -> None:
    symbol = SymbolDoc(
        name="apply_discount",
        symbol_type="function",
        file_path="cart.py",
        line_number=1,
        args=["rate"],
        return_type="Decimal",
    )
    generator = DocGenerator()

    assert generator.generate_docstring(
        symbol, DocFormat.MARKDOWN
    ) == generator.generate_docstring(symbol, DocFormat.GOOGLE)


def test_an_empty_name_leaves_the_description_blank() -> None:
    symbol = SymbolDoc(
        name="__", symbol_type="function", file_path="x.py", line_number=1
    )

    assert DocGenerator._infer_description(symbol) == ""


def test_diagrams_of_a_module_a_file_and_nothing(tmp_path: Path) -> None:
    pkg = tmp_path / "shop"
    pkg.mkdir()
    (pkg / "cart.py").write_text(
        "import json\n\nclass Cart:\n    pass\n", encoding="utf-8"
    )
    agent = DocumentationAgent()

    module = agent.generate_architecture_diagram(
        dir_path=str(pkg), diagram_type=DiagramType.MODULE_DEPENDENCY
    )
    from_file = agent.generate_architecture_diagram(file_path=str(pkg / "cart.py"))
    from_source = agent.generate_architecture_diagram(source="class Order:\n    pass\n")
    empty = agent.generate_architecture_diagram()

    assert "json" in module.diagram_content and module.symbols_analyzed == 0
    assert "Cart" in from_file.diagram_content and from_file.symbols_analyzed == 1
    assert "Order" in from_source.diagram_content
    assert empty.symbols_analyzed == 0
    assert agent.get_history() == [module, from_file, from_source, empty]


def test_a_file_deleted_while_its_folder_is_read_is_left_out(tmp_path: Path) -> None:
    pkg = tmp_path / "jobs"
    pkg.mkdir()
    (pkg / "gone.py").write_text("class Gone:\n    pass\n", encoding="utf-8")
    (pkg / "kept.py").write_text("def kept():\n    pass\n", encoding="utf-8")

    class RacingAnalyzer(DocAnalyzer):
        # Another process removes gone.py between the listing and the read.
        def analyze_file(self, file_path: str) -> list[SymbolDoc]:
            if file_path.endswith("gone.py"):
                Path(file_path).unlink()
            return super().analyze_file(file_path)

    info = RacingAnalyzer().analyze_directory(str(pkg))

    assert info.files == ["gone.py", "kept.py"]
    assert info.classes == []
    assert info.functions == ["kept"]
