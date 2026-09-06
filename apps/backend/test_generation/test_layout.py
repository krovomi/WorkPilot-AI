"""Tests for test-file destination resolution (layout.py)."""

from pathlib import Path

from test_generation.layout import (
    conventional_test_file_name,
    find_source_root,
    find_test_dir,
    resolve_test_destination,
    sanitize_file_name,
)


def _touch(path: Path, content: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _dotnet_project(root: Path, *, with_tests: bool) -> Path:
    """A .NET project with sources under src/ — the shape from the report."""
    (root / ".git").mkdir(parents=True)
    source = _touch(root / "src" / "Program.cs", "class Program {}")
    _touch(root / "src" / "App.csproj", "<Project />")
    if with_tests:
        (root / "tests").mkdir()
    return source


# ── File naming ──────────────────────────────────────────────────────


def test_file_name_follows_language_conventions():
    assert conventional_test_file_name("/p/src/calculator.py") == "test_calculator.py"
    assert conventional_test_file_name("/p/src/calculator.ts") == "calculator.test.ts"
    assert conventional_test_file_name("/p/src/Program.cs") == "ProgramTests.cs"
    assert (
        conventional_test_file_name("/p/src/OrderService.java")
        == "OrderServiceTest.java"
    )
    assert conventional_test_file_name("/p/src/parser.go") == "parser_test.go"
    assert conventional_test_file_name("/p/src/account.rb") == "account_spec.rb"


def test_file_name_pascal_cases_dashed_stems_for_dotnet():
    assert (
        conventional_test_file_name("/p/src/order-service.cs") == "OrderServiceTests.cs"
    )


def test_sanitize_file_name_keeps_only_the_name():
    assert sanitize_file_name("tests/unit/test_calc.py") == "test_calc.py"
    assert sanitize_file_name("../../etc/passwd") == "passwd"
    assert sanitize_file_name("C:\\proj\\ProgramTests.cs") == "ProgramTests.cs"
    assert sanitize_file_name("") == ""
    assert sanitize_file_name("..") == ""


# ── Directory discovery ──────────────────────────────────────────────


def test_find_source_root_prefers_the_outermost_match(tmp_path):
    source = _touch(tmp_path / "src" / "vendor" / "src" / "a.ts")
    assert find_source_root(str(source), tmp_path) == (tmp_path / "src").resolve()


def test_find_source_root_falls_back_to_a_sibling_of_the_project_root(tmp_path):
    (tmp_path / "sources").mkdir()
    source = _touch(tmp_path / "apps" / "api" / "main.py")
    assert find_source_root(str(source), tmp_path) == (tmp_path / "sources").resolve()


def test_find_test_dir_recognises_a_dotnet_test_project(tmp_path):
    (tmp_path / "App").mkdir()
    (tmp_path / "App.Tests").mkdir()
    assert find_test_dir(tmp_path) == tmp_path / "App.Tests"


def test_find_test_dir_returns_none_when_there_is_nothing(tmp_path):
    (tmp_path / "src").mkdir()
    assert find_test_dir(tmp_path) is None


# ── Resolution ───────────────────────────────────────────────────────


def test_existing_tests_dir_beside_the_source_root_wins(tmp_path):
    source = _dotnet_project(tmp_path, with_tests=True)

    destination = resolve_test_destination(
        str(source), project_root=str(tmp_path), proposed_path="ProgramTests.cs"
    )

    assert destination.status == "resolved"
    assert destination.reason == "existing_tests_dir"
    assert Path(destination.path) == (tmp_path / "tests" / "ProgramTests.cs").resolve()


def test_no_tests_dir_asks_instead_of_writing_to_the_project_root(tmp_path):
    """The reported bug: ProgramTests.cs landed next to the solution file."""
    source = _dotnet_project(tmp_path, with_tests=False)

    destination = resolve_test_destination(
        str(source), project_root=str(tmp_path), proposed_path="ProgramTests.cs"
    )

    assert destination.status == "needs_choice"
    assert destination.reason == "no_tests_dir"
    # The best candidate is still filled in, so a caller with nobody to ask has
    # somewhere sane to write — never the project root itself.
    assert Path(destination.directory) == (tmp_path / "tests").resolve()
    assert Path(destination.directory) != tmp_path.resolve()
    kinds = [c.kind for c in destination.candidates]
    assert kinds[0] == "sibling_of_source_root"
    assert "source_dir" in kinds
    assert destination.candidates[0].exists is False


def test_explicit_directory_ends_the_question(tmp_path):
    source = _dotnet_project(tmp_path, with_tests=False)
    chosen = tmp_path / "test" / "Unit"

    destination = resolve_test_destination(
        str(source),
        project_root=str(tmp_path),
        explicit_dir=str(chosen),
        proposed_path="ProgramTests.cs",
    )

    assert destination.status == "resolved"
    assert destination.reason == "explicit_directory"
    assert Path(destination.path) == chosen / "ProgramTests.cs"


def test_a_relative_choice_is_relative_to_the_project(tmp_path):
    """The dialog offers "tests/App.Tests"; the CWD must not decide where that is."""
    source = _dotnet_project(tmp_path, with_tests=False)

    destination = resolve_test_destination(
        str(source),
        project_root=str(tmp_path),
        explicit_dir="tests/App.UnitTests",
        proposed_path="ProgramTests.cs",
    )

    assert (
        Path(destination.directory) == (tmp_path / "tests" / "App.UnitTests").resolve()
    )


def test_an_existing_test_file_keeps_its_own_directory(tmp_path):
    source = _dotnet_project(tmp_path, with_tests=True)
    existing = _touch(tmp_path / "MyApp.Tests" / "ProgramTests.cs", "// old")

    destination = resolve_test_destination(
        str(source),
        project_root=str(tmp_path),
        existing_test_path=str(existing),
        proposed_path="ProgramTests.cs",
    )

    assert destination.reason == "existing_test_file"
    assert Path(destination.directory) == existing.parent


def test_python_project_with_tests_beside_src(tmp_path):
    (tmp_path / ".git").mkdir()
    source = _touch(tmp_path / "src" / "calculator.py", "def add(a, b): return a + b")
    (tmp_path / "tests").mkdir()

    destination = resolve_test_destination(
        str(source), project_root=str(tmp_path), proposed_path="tests/test_calc.py"
    )

    # The model's directory is dropped, its file name kept.
    assert Path(destination.path) == (tmp_path / "tests" / "test_calc.py").resolve()


def test_existing_co_located_js_convention_is_respected(tmp_path):
    (tmp_path / ".git").mkdir()
    source = _touch(tmp_path / "src" / "utils" / "format.ts", "export {}")
    (tmp_path / "src" / "__tests__").mkdir(parents=True)

    destination = resolve_test_destination(str(source), project_root=str(tmp_path))

    assert destination.status == "resolved"
    assert Path(destination.directory) == (tmp_path / "src" / "__tests__").resolve()
    assert destination.file_name == "format.test.ts"


def test_go_tests_stay_next_to_their_source(tmp_path):
    (tmp_path / "go.mod").write_text("module x\n", encoding="utf-8")
    source = _touch(tmp_path / "src" / "parser" / "parse.go", "package parser")
    (tmp_path / "tests").mkdir()

    destination = resolve_test_destination(str(source), project_root=str(tmp_path))

    assert destination.reason == "co_located_convention"
    assert Path(destination.directory) == source.parent.resolve()
    assert destination.file_name == "parse_test.go"


def test_no_source_root_at_all_asks_with_the_project_tests_dir_first(tmp_path):
    (tmp_path / ".git").mkdir()
    source = _touch(tmp_path / "Program.cs", "class Program {}")

    destination = resolve_test_destination(str(source), project_root=str(tmp_path))

    assert destination.status == "needs_choice"
    assert destination.reason == "no_source_root"
    assert Path(destination.directory) == (tmp_path / "tests").resolve()


def test_to_dict_is_json_shaped_for_the_ipc_bridge(tmp_path):
    source = _dotnet_project(tmp_path, with_tests=False)

    payload = resolve_test_destination(
        str(source), project_root=str(tmp_path)
    ).to_dict()

    assert payload["status"] == "needs_choice"
    assert payload["file_name"] == "ProgramTests.cs"
    assert payload["path"].endswith("ProgramTests.cs")
    assert all(
        set(candidate) == {"path", "kind", "exists"}
        for candidate in payload["candidates"]
    )
