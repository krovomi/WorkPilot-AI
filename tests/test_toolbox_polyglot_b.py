"""Toolbox, second half: the analyses read every stack, not only Node and Python.

Pipeline generator (stack detection, Azure and Bitbucket), code migration
(source stack and honest plan status), notebook checks (.NET Polyglot,
Quarto, R Markdown) and the API contract watcher (contract files of any
backend, build folders skipped).
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1] / "apps" / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from notebook_agent.formats import discover, parse_text_notebook  # noqa: E402
from notebook_agent.notebook_handler import CellType, NotebookHandler  # noqa: E402
from project.stack import detect_project_stack  # noqa: E402
from runners import api_watcher_runner, pipeline_generator_runner  # noqa: E402
from runners.code_migration_runner import CodeMigrationRunner  # noqa: E402


def _write(root: Path, rel: str, text: str = "") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ── pipeline generator ───────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("manifest", "language", "runner"),
    [
        ("composer.json", "php", "phpunit"),
        ("Gemfile", "ruby", "rspec / rake test"),
        ("pubspec.yaml", "dart", "flutter test / dart test"),
        ("Package.swift", "swift", "swift test"),
        ("mix.exs", "elixir", "mix test"),
    ],
)
def test_stack_detection_covers_the_other_ecosystems(
    tmp_path: Path, manifest: str, language: str, runner: str
) -> None:
    _write(tmp_path, manifest, "{}")
    stack = detect_project_stack(tmp_path)
    assert language in stack["languages"]
    assert runner in stack["test_runners"]


def test_fsharp_and_vb_projects_are_dotnet(tmp_path: Path) -> None:
    _write(tmp_path, "src/Domain/Domain.fsproj", "<Project/>")
    _write(tmp_path, "src/Legacy/Legacy.vbproj", "<Project/>")
    stack = detect_project_stack(tmp_path)
    assert stack["languages"] == ["c#"]
    assert "dotnet test" in stack["test_runners"]


def test_test_runners_follow_the_detected_languages(tmp_path: Path) -> None:
    _write(tmp_path, "go.mod", "module x")
    _write(tmp_path, "Cargo.toml", "[package]")
    _write(tmp_path, "pom.xml", "<project/>")
    runners = detect_project_stack(tmp_path)["test_runners"]
    assert {"go test ./...", "cargo test", "junit (maven/gradle test)"} <= set(runners)


def test_frontend_frameworks_beyond_react(tmp_path: Path) -> None:
    _write(
        tmp_path,
        "package.json",
        '{"dependencies": {"@angular/core": "19", "nuxt": "4", "svelte": "5"}}',
    )
    frameworks = detect_project_stack(tmp_path)["frameworks"]
    assert {"angular", "nuxt", "svelte"} <= set(frameworks)


def test_existing_ci_of_every_platform_is_reported(tmp_path: Path) -> None:
    _write(tmp_path, "azure-pipelines.yml", "trigger: [main]")
    _write(tmp_path, "bitbucket-pipelines.yml", "pipelines: {}")
    _write(tmp_path, "Jenkinsfile", "pipeline {}")
    ci = detect_project_stack(tmp_path)["existing_ci"]
    assert {"azure_pipelines", "bitbucket_pipelines", "jenkins"} <= set(ci)


def test_pipelines_for_azure_and_bitbucket(tmp_path: Path) -> None:
    assert {"azure", "bitbucket"} <= set(pipeline_generator_runner.SUPPORTED_PLATFORMS)
    assert (
        pipeline_generator_runner.PLATFORM_OUTPUT_FILES["azure"]
        == "azure-pipelines.yml"
    )
    prompt = pipeline_generator_runner.build_generation_prompt(
        tmp_path, {"languages": ["c#"]}, ["azure", "bitbucket"]
    )
    assert "<platform_id> is one of: azure, bitbucket" in prompt
    assert "NuGet" in prompt and "Azure Pipelines" in prompt


# ── code migration ───────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("description", "expected"),
    [
        ("Upgrade from .NET 8 to .NET 10 and C# 14", ("dotnet", "csharp")),
        ("Upgrade Spring Boot 2 to 3 (javax to jakarta)", ("spring-boot", None)),
        ("Convert the Java classes to Kotlin", (None, "kotlin")),
        ("Port the service to Go", (None, "go")),
        ("Upgrade from PHP 7.4 to PHP 8.3 with Laravel", ("laravel", "php")),
        ("Trust the javascript build", (None, "javascript")),
    ],
)
def test_migration_targets_of_every_stack(description: str, expected: tuple) -> None:
    runner = CodeMigrationRunner(
        project_dir="/nonexistent", migration_description=description
    )
    assert runner._parse_migration_description() == expected


def test_migration_reports_the_real_stack_and_an_honest_plan(tmp_path: Path) -> None:
    _write(tmp_path, "Shop/Shop.csproj", "<Project/>")
    runner = CodeMigrationRunner(
        project_dir=str(tmp_path),
        migration_description="Upgrade from .NET 8 to .NET 10",
        dry_run=True,
    )
    runner.setup()
    result = runner.run_migration()
    assert result["plan"]["source"] == "c#"
    # The rule-based planner does not know the pair: said so, not "success".
    assert result["summary"]["plan_status"] == "unsupported"
    assert result["summary"]["files_modified"] == 0


def test_migration_without_dry_run_does_not_claim_a_queue(tmp_path: Path) -> None:
    runner = CodeMigrationRunner(
        project_dir=str(tmp_path), migration_description="Convert to Kotlin"
    )
    runner.setup()
    assert runner.run_migration()["execution"]["status"] == "not_run"


# ── notebooks ────────────────────────────────────────────────────────────────


def test_polyglot_notebook_cells(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "analysis.dib",
        "#!meta\n{}\n#!markdown\n# Sales\n#!csharp\nvar x = 1;\n#!fsharp\n\n#!sql\nSELECT 1\n",
    )
    nb = parse_text_notebook(path)
    kinds = [c.cell_type for c in nb.cells]
    assert kinds == [CellType.MARKDOWN, CellType.CODE, CellType.CODE, CellType.CODE]
    assert nb.language == "csharp, fsharp, sql"
    issues = NotebookHandler().analyze(nb)
    assert any(i.issue_type.value == "empty_cell" and i.cell_index == 2 for i in issues)


@pytest.mark.parametrize("name", ["report.qmd", "report.Rmd"])
def test_quarto_and_r_markdown_chunks(tmp_path: Path, name: str) -> None:
    path = _write(
        tmp_path,
        name,
        "---\ntitle: R\n---\n\nIntro text\n\n```{r setup, echo=FALSE}\nlibrary(dplyr)\n```\n\n"
        "```{python}\nprint(1)\n```\n",
    )
    nb = NotebookHandler().parse(path)
    assert [c.cell_type for c in nb.cells] == [
        CellType.MARKDOWN,
        CellType.CODE,
        CellType.CODE,
    ]
    assert nb.language == "python, r"


def test_notebook_discovery_skips_build_folders(tmp_path: Path) -> None:
    _write(tmp_path, "notebooks/a.ipynb", "{}")
    _write(tmp_path, "notebooks/b.dib", "#!csharp\n1")
    _write(tmp_path, "docs/c.qmd", "x")
    _write(tmp_path, "bin/Debug/d.ipynb", "{}")
    _write(tmp_path, "node_modules/pkg/e.ipynb", "{}")
    names = [p.name for p in discover(tmp_path)]
    assert names == ["c.qmd", "a.ipynb", "b.dib"]


def test_jupyter_source_as_one_string_and_unknown_cell_type(tmp_path: Path) -> None:
    path = _write(
        tmp_path,
        "nb.ipynb",
        '{"cells": [{"cell_type": "code", "source": "x = 1"},'
        ' {"cell_type": "widget", "source": ["y"]}], "metadata": {}}',
    )
    nb = NotebookHandler().parse(path)
    assert nb.cells[0].source == "x = 1"
    assert nb.cells[1].cell_type is CellType.RAW


# ── API contract watcher ─────────────────────────────────────────────────────


def test_contracts_of_every_backend_are_found(tmp_path: Path) -> None:
    _write(
        tmp_path, "src/main/resources/graphql/schema.graphqls", "type Query { a: Int }"
    )
    _write(tmp_path, "api/v1.yaml", "# Orders\nopenapi: 3.1.0\ninfo: {}\n")
    _write(tmp_path, "contracts/notes.yml", "name: not a contract\n")
    _write(tmp_path, "Api/wwwroot/orders.swagger.json", '{"swagger": "2.0"}')
    _write(tmp_path, "proto/orders.proto", 'syntax = "proto3";')
    _write(tmp_path, "Api/bin/Debug/swagger.json", '{"swagger": "2.0"}')
    _write(tmp_path, "vendor/lib/openapi.yaml", "openapi: 3.0.0")
    found = {
        p.relative_to(tmp_path.resolve()).as_posix()
        for p in api_watcher_runner._discover_specs(tmp_path)
    }
    assert found == {
        "src/main/resources/graphql/schema.graphqls",
        "api/v1.yaml",
        "Api/wwwroot/orders.swagger.json",
        "proto/orders.proto",
    }


def test_graphqls_is_parsed_as_graphql(tmp_path: Path) -> None:
    from api_watcher.contract_parser import ContractFormat, ContractParser

    path = _write(tmp_path, "schema.graphqls", "type Query { a: Int }")
    assert ContractParser.detect_format(path) is ContractFormat.GRAPHQL


# ── browser agent: E2E tests of every stack ──────────────────────────────────


def test_e2e_tests_of_every_stack_are_discovered(tmp_path: Path) -> None:
    from browser_agent.test_executor import TestExecutor

    _write(tmp_path, "e2e/login.spec.ts")
    _write(tmp_path, "cypress/e2e/cart.cy.ts")
    _write(tmp_path, "tests/Shop.E2ETests/CheckoutTests.cs")
    _write(tmp_path, "tests/Shop.E2ETests/Shop.E2ETests.csproj", "<Project/>")
    _write(tmp_path, "tests/Shop.E2ETests/bin/Debug/GeneratedTests.cs")
    _write(tmp_path, "src/ui-tests/LoginIT.java")
    _write(tmp_path, "e2e/flow_test.go")
    _write(tmp_path, "e2e/signup_spec.rb")
    _write(tmp_path, "tests/Browser/LoginTest.php")
    found = {t.path: t.type for t in TestExecutor(tmp_path).discover_tests()}
    assert found == {
        "e2e/login.spec.ts": "playwright",
        "cypress/e2e/cart.cy.ts": "cypress",
        "tests/Shop.E2ETests/CheckoutTests.cs": "dotnet",
        "src/ui-tests/LoginIT.java": "junit",
        "e2e/flow_test.go": "go",
        "e2e/signup_spec.rb": "rspec",
        "tests/Browser/LoginTest.php": "phpunit",
    }


def test_each_stack_runs_its_own_tool(tmp_path: Path) -> None:
    from browser_agent import e2e_stacks

    _write(tmp_path, "tests/Shop.E2ETests/Shop.E2ETests.csproj", "<Project/>")
    dotnet = e2e_stacks.KIND_BY_TYPE["dotnet"].commands(
        tmp_path, ["tests/Shop.E2ETests/CheckoutTests.cs"]
    )
    assert dotnet[0][1:] == ["test", str(tmp_path / "tests" / "Shop.E2ETests")]
    _write(tmp_path, "pom.xml", "<project/>")
    mvn = e2e_stacks.KIND_BY_TYPE["junit"].commands(
        tmp_path, ["src/ui-tests/LoginIT.java"]
    )
    assert mvn[0][1:] == ["-q", "test", "-Dtest=LoginIT"]
    go = e2e_stacks.KIND_BY_TYPE["go"].commands(tmp_path, ["e2e/flow_test.go"])
    assert go[0][1:] == ["test", "./e2e"]


def test_missing_tool_is_reported_not_raised(tmp_path: Path, monkeypatch) -> None:
    from browser_agent import e2e_stacks
    from browser_agent.models import TestInfo

    def boom(*_args, **_kwargs):
        raise FileNotFoundError

    monkeypatch.setattr(e2e_stacks.subprocess, "run", boom)
    results = e2e_stacks.run_kind(
        tmp_path,
        "rspec",
        [TestInfo(name="signup_spec", path="e2e/signup_spec.rb", type="rspec")],
    )
    assert results[0].status == "error"
    assert "Bundler" in (results[0].error_message or "")


# ── API Studio: routes of every backend ──────────────────────────────────────


def test_routes_of_laravel_nestjs_and_kotlin_spring(tmp_path: Path) -> None:
    from analysis.analyzers.route_detector import RouteDetector

    _write(
        tmp_path,
        "routes/api.php",
        "<?php\nRoute::get('/orders', [OrderController::class, 'index'])->middleware('auth:sanctum');\n"
        "Route::post('orders', [OrderController::class, 'store']);\n",
    )
    _write(
        tmp_path,
        "src/orders/orders.controller.ts",
        "@UseGuards(AuthGuard)\n@Controller('orders')\nexport class OrdersController {\n"
        "  @Get(':id')\n  find() {}\n  @Post()\n  create() {}\n}\n",
    )
    _write(
        tmp_path,
        "src/main/kotlin/Api.kt",
        '@RestController\n@RequestMapping("/api/items")\nclass Api {\n  @GetMapping("/{id}")\n  fun one() {}\n}\n',
    )
    _write(
        tmp_path, "vendor/laravel/routes/web.php", "Route::get('/vendored', fn() => 1);"
    )
    routes = {
        (r["framework"], r["methods"][0], r["path"], r["requires_auth"])
        for r in RouteDetector(tmp_path).detect_all_routes()
    }
    assert ("Laravel", "GET", "/api/orders", True) in routes
    assert ("Laravel", "POST", "/api/orders", False) in routes
    assert ("NestJS", "GET", "/orders/:id", True) in routes
    assert ("NestJS", "POST", "/orders", True) in routes
    assert ("Spring Boot", "GET", "/api/items/{id}", False) in routes
    assert not any(path == "/vendored" for _, _, path, _ in routes)


def test_a_project_under_a_build_folder_keeps_its_routes(tmp_path: Path) -> None:
    from analysis.analyzers.route_detector import RouteDetector

    root = tmp_path / "build" / "shop"
    _write(root, "routes/web.php", "Route::get('/home', fn() => 1);")
    assert [r["path"] for r in RouteDetector(root).detect_all_routes()] == ["/home"]
