"""Tests for the onboarding agent package builder.

The page these feed ("Agent d'intégration") was showing a single quiz
question on a real .NET repository: nothing detected the stack, so nothing
downstream had anything to ask about. These tests pin the two halves of that
fix — detection covers stacks by evidence, and the quiz draws from the whole
guide rather than from the tour alone.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parents[2] / "apps" / "backend"
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from onboarding_agent import (  # noqa: E402
    OnboardingEngine,
    OnboardingPackageBuilder,
    build_glossary,
    build_quiz,
    build_tour,
    render_markdown,
    scan_project,
)

CSPROJ = """<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.EntityFrameworkCore" Version="8.0.0" />
    <PackageReference Include="MediatR" Version="12.2.0" />
    <PackageReference Include="Serilog.AspNetCore" Version="8.0.0" />
  </ItemGroup>
</Project>
"""

TEST_CSPROJ = """<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="xunit" Version="2.6.0" />
    <PackageReference Include="FluentAssertions" Version="6.12.0" />
  </ItemGroup>
</Project>
"""


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


@pytest.fixture
def dotnet_repo(tmp_path: Path) -> Path:
    """A clean-architecture .NET solution — the shape that produced 1 question."""
    root = tmp_path / "Shop"
    _write(root / "README.md", "# Shop\n\nA sample API.\n")
    _write(root / "Shop.sln", "Microsoft Visual Studio Solution File\n")
    _write(root / ".editorconfig", "root = true\n[*.cs]\nindent_size = 4\n")
    _write(root / "src" / "Shop.Api" / "Shop.Api.csproj", CSPROJ)
    _write(
        root / "src" / "Shop.Api" / "Program.cs",
        "var builder = WebApplication.CreateBuilder(args);\napp.Run();\n",
    )
    _write(
        root / "tests" / "Shop.Domain.Tests" / "Shop.Domain.Tests.csproj", TEST_CSPROJ
    )

    for index in range(1, 4):
        _write(
            root / "src" / "Shop.Api" / "Controllers" / f"Order{index}Controller.cs",
            f"public class Order{index}Controller\n{{\n"
            + "    // route\n" * 60
            + "}\n",
        )
        _write(
            root / "src" / "Shop.Domain" / "Entities" / f"Order{index}.cs",
            f"public record Order{index}\n{{\n" + "    // property\n" * 50 + "}\n",
        )
        _write(
            root
            / "src"
            / "Shop.Application"
            / "UseCases"
            / f"PlaceOrder{index}Handler.cs",
            f"public class PlaceOrder{index}Handler\n{{\n"
            "    // TODO: validate the basket before charging\n"
            + "    // step\n" * 45
            + "}\n",
        )
        _write(
            root
            / "src"
            / "Shop.Infrastructure"
            / "Persistence"
            / f"OrderRepository{index}.cs",
            f"public class OrderRepository{index}\n{{\n"
            + "    // query\n" * 40
            + "}\n",
        )
        _write(
            root / "tests" / "Shop.Domain.Tests" / f"Order{index}Tests.cs",
            f"public class Order{index}Tests {{ }}\n",
        )
    return root


@pytest.fixture
def node_repo(tmp_path: Path) -> Path:
    root = tmp_path / "web"
    _write(root / "README.md", "# web\n")
    _write(
        root / "package.json",
        '{"name":"web","scripts":{"dev":"vite","test":"vitest","lint":"biome check ."},'
        '"dependencies":{"react":"19.0.0"},"devDependencies":{"vite":"8.0.0"}}',
    )
    _write(root / "pnpm-lock.yaml", "lockfileVersion: 9\n")
    _write(root / "src" / "main.tsx", "export const main = () => null;\n")
    _write(root / "src" / "components" / "button.tsx", "export const Button = 1;\n")
    _write(root / "src" / "components" / "card.tsx", "export const Card = 1;\n")
    for name in ("use-thing", "use-store", "use-toast", "use-router"):
        _write(root / "src" / "hooks" / f"{name}.ts", f"export const {name} = 1;\n")
    for name in ("date-format", "http-client", "error-boundary"):
        _write(root / "src" / "lib" / f"{name}.ts", f"export const {name} = 1;\n")
    _write(root / "src" / "__tests__" / "button.test.tsx", "it('x', () => {});\n")
    _write(root / "src" / "__tests__" / "card.test.tsx", "it('x', () => {});\n")
    return root


# --- detection -------------------------------------------------------------


def test_dotnet_stack_is_detected_from_project_files(dotnet_repo: Path) -> None:
    guide = OnboardingEngine().generate(dotnet_repo)

    assert any("C#" in tech or ".NET" in tech for tech in guide.tech_stack)
    assert ".NET (net8.0)" in guide.tech_stack
    assert "Entity Framework Core" in guide.tech_stack
    assert "xUnit" in guide.tech_stack


def test_dotnet_commands_and_entry_point(dotnet_repo: Path) -> None:
    guide = OnboardingEngine().generate(dotnet_repo)

    commands = {c.command for c in guide.commands}
    assert "dotnet restore" in commands
    assert "dotnet test" in commands
    assert [e.path for e in guide.entry_points] == ["src/Shop.Api/Program.cs"]


def test_clean_architecture_layers_get_their_role(dotnet_repo: Path) -> None:
    guide = OnboardingEngine().generate(dotnet_repo)
    roles = {node.path: node.role for node in guide.architecture}

    assert "Domain layer" in roles["src/Shop.Domain"]
    assert "Application layer" in roles["src/Shop.Application"]
    assert "Infrastructure layer" in roles["src/Shop.Infrastructure"]
    # A `*.Tests` project is a test project even when it names a layer.
    assert roles["tests/Shop.Domain.Tests"] == "Automated tests"


def test_node_scripts_become_commands(node_repo: Path) -> None:
    guide = OnboardingEngine().generate(node_repo)

    commands = {c.command: c.category for c in guide.commands}
    assert commands["pnpm install"] == "setup"  # lockfile picks the runner
    assert commands["pnpm run test"] == "test"
    assert commands["pnpm run lint"] == "lint"
    assert "React" in guide.tech_stack


def test_conventions_are_detected_from_the_sources(node_repo: Path) -> None:
    guide = OnboardingEngine().generate(node_repo)
    names = [c.name for c in guide.conventions]

    assert any(name.startswith("File names use kebab-case") for name in names)
    assert any(name.startswith("Tests live as") for name in names)


# --- package ---------------------------------------------------------------


def test_package_is_substantial_on_a_real_shaped_repo(dotnet_repo: Path) -> None:
    package = OnboardingPackageBuilder().build(dotnet_repo)

    assert len(package.tour) >= 6
    assert len(package.quiz) >= 8, "the page shipped with a single question"
    assert len(package.first_tasks) >= 3
    assert len(package.glossary) >= 5


def test_quiz_covers_more_than_one_category(dotnet_repo: Path) -> None:
    package = OnboardingPackageBuilder().build(dotnet_repo)
    categories = {q.category for q in package.quiz}

    assert {"stack", "files", "commands", "architecture"} <= categories


def test_quiz_answers_are_not_always_the_first_choice(dotnet_repo: Path) -> None:
    package = OnboardingPackageBuilder().build(dotnet_repo)
    indexes = {q.correct_index for q in package.quiz}

    assert len(indexes) > 1
    for question in package.quiz:
        assert 3 <= len(question.choices) <= 4
        assert len(set(question.choices)) == len(question.choices)
        assert 0 <= question.correct_index < len(question.choices)


def test_package_generation_is_deterministic(dotnet_repo: Path) -> None:
    first = OnboardingPackageBuilder().build(dotnet_repo).to_dict()
    second = OnboardingPackageBuilder().build(dotnet_repo).to_dict()

    assert first == second


def test_first_tasks_ignore_test_fixtures_and_derive_suggestions(
    node_repo: Path,
) -> None:
    guide = OnboardingEngine().generate(node_repo)
    package = OnboardingPackageBuilder().build(node_repo)

    assert guide.commands  # sanity: the manifest was read
    assert package.first_tasks, "a repo with no TODO still needs somewhere to start"
    assert {t.category for t in package.first_tasks} <= {
        "todo",
        "tests",
        "docs",
        "explore",
    }
    assert not any("__tests__" in t.file_path for t in package.first_tasks)


def test_glossary_prefers_directories_and_types_over_keywords(
    dotnet_repo: Path,
) -> None:
    scan = scan_project(dotnet_repo)
    guide = OnboardingEngine().generate(dotnet_repo, scan=scan)
    glossary = build_glossary(dotnet_repo, architecture=guide.architecture, scan=scan)

    terms = {term.term for term in glossary}
    assert "Shop.Domain" in terms
    assert all(term.definition for term in glossary)
    assert not ({"public", "class", "namespace", "record"} & {t.lower() for t in terms})


def test_tour_walks_docs_entry_points_and_layers(dotnet_repo: Path) -> None:
    guide = OnboardingEngine().generate(dotnet_repo)
    tour = build_tour(guide, dotnet_repo)

    categories = [step.category for step in tour]
    assert categories[0] == "doc"
    assert "entrypoint" in categories
    assert "directory" in categories
    assert [step.order for step in tour] == list(range(1, len(tour) + 1))


def test_empty_project_degrades_without_raising(tmp_path: Path) -> None:
    package = OnboardingPackageBuilder().build(tmp_path)

    assert package.guide.project_name == tmp_path.name
    assert package.quiz == []  # nothing detected, nothing invented
    assert render_markdown(package).startswith("# Onboarding — ")


def test_quiz_never_emits_a_question_with_a_single_distractor() -> None:
    class _Guide:
        project_name = "solo"
        tech_stack = ["Python"]
        key_files: list = []
        entry_points: list = []
        conventions: list = []
        commands: list = []
        architecture: list = []

    quiz = build_quiz([], _Guide())  # type: ignore[arg-type]

    assert all(len(q.choices) >= 3 for q in quiz)
