"""Tests for the test-library catalogue and selection (libraries.py)."""

from pathlib import Path

import pytest
from test_generation.libraries import (
    CATALOGUE,
    CATEGORY_ORDER,
    catalogue_for,
    detect_installed,
    install_commands,
    missing_packages,
    parse_ids,
    render_prompt_section,
    resolve_selection,
)

CSPROJ = """<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="xunit" Version="2.9.0" />
    <PackageReference Include="FluentAssertions" Version="6.12.0" />
  </ItemGroup>
</Project>
"""


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


# ── The catalogue itself ─────────────────────────────────────────────


def test_every_entry_is_addressable_and_categorised():
    """Ids reach the prompt and the UI; a typo here is a silent no-op."""
    ids = [library.id for library in CATALOGUE]
    assert len(ids) == len(set(ids)), "duplicate library id"
    for library in CATALOGUE:
        assert library.category in CATEGORY_ORDER, library.id
        assert library.usage.strip(), library.id
        assert library.package.strip(), library.id


def test_catalogue_puts_frameworks_first():
    csharp = catalogue_for("csharp")
    assert csharp[0].category == "framework"
    assert {library.id for library in csharp} >= {"xunit", "fluentassertions", "moq"}


def test_javascript_shares_the_typescript_catalogue():
    """One npm ecosystem, one list — a .js project offers vitest too."""
    assert catalogue_for("javascript") == catalogue_for("typescript")


def test_parse_ids_drops_what_the_catalogue_does_not_know():
    assert parse_ids("xunit, moq ,nope") == ["xunit", "moq"]
    assert parse_ids("moq,moq") == ["moq"]
    assert parse_ids(None) == []
    assert parse_ids("") == []


# ── What the project already references ──────────────────────────────


def test_detects_nuget_packages_from_a_csproj(tmp_path):
    _write(tmp_path / "src" / "App.csproj", CSPROJ)

    installed = detect_installed(tmp_path, "csharp")

    assert installed["xunit"] == "2.9.0"
    assert installed["fluentassertions"] == "6.12.0"


def test_detects_a_packages_config_project(tmp_path):
    _write(
        tmp_path / "Legacy" / "packages.config",
        '<?xml version="1.0"?><packages>'
        '<package id="NUnit" version="3.14.0" targetFramework="net48" />'
        "</packages>",
    )

    installed = detect_installed(tmp_path, "csharp")

    assert "nunit" in installed


def test_detects_npm_dev_dependencies(tmp_path):
    _write(
        tmp_path / "package.json",
        '{"devDependencies": {"vitest": "^4.0.0", "msw": "2.0.0"}}',
    )

    installed = detect_installed(tmp_path, "typescript")

    assert "vitest" in installed
    assert "msw" in installed


def test_detects_python_requirements(tmp_path):
    _write(tmp_path / "requirements-dev.txt", "# comment\npytest==8.0.0\nhypothesis\n")

    installed = detect_installed(tmp_path, "python")

    assert "pytest" in installed
    assert "hypothesis" in installed


def test_a_project_that_is_not_there_detects_nothing(tmp_path):
    assert detect_installed(tmp_path / "nope", "csharp") == {}


# ── Selection ────────────────────────────────────────────────────────


def test_the_project_decides_when_the_user_has_not(tmp_path):
    _write(tmp_path / "src" / "App.csproj", CSPROJ)

    selection = resolve_selection(tmp_path, "csharp")

    assert selection.ids() == ["xunit", "fluentassertions"]
    assert selection.explicit is False
    assert missing_packages(selection) == []


def test_a_bare_project_falls_back_to_the_recommended_set(tmp_path):
    _write(tmp_path / "src" / "App.csproj", "<Project />")

    selection = resolve_selection(tmp_path, "csharp")

    # A suggestion, not a decision: the UI shows these pre-checked.
    assert set(selection.ids()) == {"xunit", "test-sdk", "fluentassertions", "moq"}
    assert selection.explicit is False
    assert selection.installed_ids == []


def test_the_user_choice_wins_over_the_project(tmp_path):
    _write(tmp_path / "src" / "App.csproj", CSPROJ)

    selection = resolve_selection(tmp_path, "csharp", ["nunit", "nsubstitute"])

    assert selection.ids() == ["nunit", "nsubstitute"]
    assert selection.explicit is True
    # FluentAssertions stays reported as installed even though it was not picked.
    assert "fluentassertions" in selection.installed_ids


def test_missing_packages_are_the_chosen_ones_the_project_lacks(tmp_path):
    _write(tmp_path / "src" / "App.csproj", CSPROJ)

    selection = resolve_selection(tmp_path, "csharp", ["xunit", "moq", "autofixture"])

    assert [library.package for library in missing_packages(selection)] == [
        "Moq",
        "AutoFixture",
    ]
    assert install_commands(selection) == [
        "dotnet add <test project> package Moq",
        "dotnet add <test project> package AutoFixture",
    ]


def test_npm_missing_packages_are_one_command(tmp_path):
    _write(tmp_path / "package.json", '{"devDependencies": {"vitest": "^4.0.0"}}')

    selection = resolve_selection(tmp_path, "typescript", ["vitest", "msw", "faker-js"])

    assert install_commands(selection) == ["npm install --save-dev msw @faker-js/faker"]


# ── What the model is told ───────────────────────────────────────────


def test_the_prompt_section_names_the_packages_and_how_to_use_them(tmp_path):
    _write(tmp_path / "src" / "App.csproj", CSPROJ)

    section = render_prompt_section(resolve_selection(tmp_path, "csharp"))

    assert "FluentAssertions" in section
    assert "result.Should().Be(...)" in section
    # The constraint is the point: a test using a package the project lacks
    # does not compile.
    assert "ONLY these libraries" in section


def test_no_selection_renders_nothing(tmp_path):
    selection = resolve_selection(tmp_path, "csharp", [])
    selection.selected = []

    assert render_prompt_section(selection) == ""


@pytest.mark.parametrize("language", ["csharp", "typescript", "python", "java"])
def test_every_supported_language_has_something_to_offer(language):
    assert catalogue_for(language), language
