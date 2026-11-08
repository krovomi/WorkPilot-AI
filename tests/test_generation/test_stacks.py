"""Language and test framework detection for the test generator (stacks.py).

The bugs these pin: the framework came from whichever manifest answered first,
whatever the language of the file (a C# class in a solution with a front-end
``package.json`` got Vitest tests); E2E and TDD runs had no file to read an
extension from and fell back to TypeScript or Python; and the prompts asked
for ``e2e/test_x.js`` from a C# project.
"""

from __future__ import annotations

import importlib.util
import re
from pathlib import Path

import pytest
from test_generation.generator import ProjectAnalyzer, TestGeneratorAgent
from test_generation.libraries import (
    detect_installed,
    install_commands,
    resolve_selection,
)
from test_generation.stacks import (
    DEFAULT_E2E_FRAMEWORK,
    DEFAULT_UNIT_FRAMEWORK,
    LANGUAGE_BY_EXTENSION,
    SUPPORTED_LANGUAGES,
    detect_framework,
    detect_project_language,
    language_for_path,
    suggested_test_path,
)

REPO = Path(__file__).resolve().parents[2]
RUNNER = REPO / "apps" / "backend" / "runners" / "test_generation_runner.py"
RENDERER_LANGUAGES = (
    REPO
    / "apps"
    / "frontend"
    / "src"
    / "shared"
    / "constants"
    / "test-studio-languages.ts"
)


def _write(path: Path, content: str = "") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


class TestEveryLanguageHasAnAnswer:
    def test_each_supported_language_has_defaults(self):
        for language in SUPPORTED_LANGUAGES:
            assert DEFAULT_UNIT_FRAMEWORK.get(language), language
            assert DEFAULT_E2E_FRAMEWORK.get(language), language

    def test_each_supported_language_is_reachable_from_an_extension(self):
        assert set(SUPPORTED_LANGUAGES) == set(LANGUAGE_BY_EXTENSION.values())

    @pytest.mark.parametrize(
        ("path", "language"),
        [
            ("lib/cart.dart", "dart"),
            ("src/engine.cpp", "cpp"),
            ("src/engine.c", "c"),
            ("Sources/App/User.swift", "swift"),
            ("app/Models/User.php", "php"),
            ("build.gradle.kts", "kotlin"),
            ("README.md", "unknown"),
        ],
    )
    def test_extensions(self, path: str, language: str):
        assert language_for_path(path) == language

    def test_the_renderer_offers_the_same_languages(self):
        """The TDD picker lists exactly what the generator supports."""
        source = RENDERER_LANGUAGES.read_text(encoding="utf-8")
        offered = re.findall(r'id: "([a-z]+)"', source)
        assert offered == list(SUPPORTED_LANGUAGES)


class TestFrameworkFollowsTheLanguage:
    def test_a_csharp_file_is_not_vitest_because_of_a_front_end(self, tmp_path: Path):
        _write(tmp_path / "package.json", '{"devDependencies": {"vitest": "^3.0.0"}}')
        _write(
            tmp_path / "tests" / "Shop.Tests" / "Shop.Tests.csproj",
            '<Project><ItemGroup><PackageReference Include="NUnit" Version="4.2.0" />'
            "</ItemGroup></Project>",
        )
        source = _write(tmp_path / "src" / "Shop" / "Cart.cs", "class Cart {}")

        detected = ProjectAnalyzer().detect(str(source), str(tmp_path))

        assert detected["language"] == "csharp"
        assert detected["test_framework"] == "nunit"
        assert "Shop.Tests.csproj" in detected["details"]

    def test_a_go_file_is_not_pytest_because_of_a_requirements_file(
        self, tmp_path: Path
    ):
        _write(tmp_path / "requirements.txt", "pytest==8.3\n")
        _write(
            tmp_path / "go.mod",
            "module shop\n\nrequire github.com/stretchr/testify v1.9.0\n",
        )
        source = _write(tmp_path / "cart.go", "package shop")

        detected = ProjectAnalyzer().detect(str(source), str(tmp_path))

        assert (detected["language"], detected["test_framework"]) == ("go", "testify")

    @pytest.mark.parametrize(
        ("manifest", "content", "language", "framework"),
        [
            ("composer.json", '{"require-dev": {"pestphp/pest": "^3"}}', "php", "pest"),
            ("Gemfile", "group :test do\n  gem 'rspec-rails'\nend\n", "ruby", "rspec"),
            (
                "pubspec.yaml",
                "dev_dependencies:\n  flutter_test:\n    sdk: flutter\n",
                "dart",
                "flutter_test",
            ),
            ("Cargo.toml", '[dev-dependencies]\nrstest = "0.23"\n', "rust", "rstest"),
            (
                "build.gradle.kts",
                'testImplementation("io.kotest:kotest-runner-junit5:5.9.1")',
                "kotlin",
                "kotest",
            ),
            ("CMakeLists.txt", "find_package(Catch2 3 REQUIRED)", "cpp", "catch2"),
            ("pyproject.toml", "[tool.pytest.ini_options]\n", "python", "pytest"),
        ],
    )
    def test_each_stack_reads_its_own_manifest(
        self, tmp_path: Path, manifest: str, content: str, language: str, framework: str
    ):
        _write(tmp_path / manifest, content)

        assert detect_framework(tmp_path, language)[0] == framework

    def test_no_manifest_means_the_language_default(self, tmp_path: Path):
        assert detect_framework(tmp_path, "swift") == ("xctest", "")
        assert detect_framework(None, "dart") == ("test", "")

    def test_e2e_looks_for_a_browser_driver(self, tmp_path: Path):
        _write(
            tmp_path / "e2e" / "Shop.E2E.csproj",
            '<Project><ItemGroup><PackageReference Include="Microsoft.Playwright.NUnit" />'
            "</ItemGroup></Project>",
        )
        _write(tmp_path / "package.json", '{"devDependencies": {"cypress": "13"}}')

        assert detect_framework(tmp_path, "csharp", "e2e")[0] == "playwright"
        assert detect_framework(tmp_path, "typescript", "e2e")[0] == "cypress"
        # Without a browser driver, the unit framework is not mistaken for one.
        assert detect_framework(tmp_path, "php", "e2e") == ("dusk", "")


class TestProjectLanguage:
    def test_a_solution_beats_its_tooling_package_json(self, tmp_path: Path):
        _write(tmp_path / "package.json", "{}")
        _write(tmp_path / "Shop.sln")

        assert detect_project_language(tmp_path) == "csharp"

    def test_typescript_is_told_apart_from_javascript(self, tmp_path: Path):
        _write(tmp_path / "package.json", "{}")
        assert detect_project_language(tmp_path) == "javascript"
        _write(tmp_path / "tsconfig.json", "{}")
        assert detect_project_language(tmp_path) == "typescript"

    def test_manifests_one_level_down(self, tmp_path: Path):
        _write(tmp_path / "README.md", "# shop")
        _write(tmp_path / "mobile" / "pubspec.yaml", "name: shop\n")

        assert detect_project_language(tmp_path) == "dart"

    def test_kotlin_gradle(self, tmp_path: Path):
        _write(tmp_path / "build.gradle", "apply plugin: 'kotlin'\n")
        assert detect_project_language(tmp_path) == "kotlin"

    def test_nothing_to_say(self, tmp_path: Path):
        assert detect_project_language(tmp_path) is None
        assert detect_project_language(None) is None


class TestSuggestedPaths:
    @pytest.mark.parametrize(
        ("language", "kind", "expected"),
        [
            ("csharp", "e2e", "e2e/CheckoutE2ETests.cs"),
            ("csharp", "unit", "tests/CheckoutTests.cs"),
            ("go", "unit", "checkout_test.go"),
            ("dart", "unit", "test/checkout_test.dart"),
            ("dart", "e2e", "integration_test/checkout_test.dart"),
            ("php", "unit", "tests/CheckoutTest.php"),
            ("ruby", "unit", "spec/checkout_spec.rb"),
            ("kotlin", "unit", "src/test/kotlin/CheckoutTest.kt"),
            ("typescript", "e2e", "e2e/checkout.spec.ts"),
            ("cpp", "unit", "tests/checkout_test.cpp"),
        ],
    )
    def test_paths_carry_the_language_extension(
        self, language: str, kind: str, expected: str
    ):
        assert suggested_test_path(language, "checkout", kind) == expected


class TestPromptsAskForTheRightFile:
    def test_a_csharp_scenario_is_not_asked_for_as_javascript(self, tmp_path: Path):
        _write(tmp_path / "Shop.sln")
        agent = TestGeneratorAgent()

        info = agent._e2e_framework_info("the checkout flow", str(tmp_path))
        prompt = agent._generate_e2e_prompt("As a buyer…", "checkout", info)

        assert info["language"] == "csharp"
        assert '"test_file_path": "e2e/CheckoutE2ETests.cs"' in prompt

    def test_a_relative_target_is_read_from_the_project(self, tmp_path: Path):
        _write(tmp_path / "composer.json", '{"require-dev": {"laravel/dusk": "^8"}}')
        _write(tmp_path / "app" / "Http" / "Checkout.php", "<?php")

        info = TestGeneratorAgent()._e2e_framework_info(
            "app/Http/Checkout.php", str(tmp_path)
        )

        assert (info["language"], info["test_framework"]) == ("php", "dusk")

    def test_a_tdd_run_without_a_language_uses_the_project(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        _write(tmp_path / "go.mod", "module shop\n")
        captured: dict = {}

        async def fake_generate(self, prompt, project_path, on_event):  # noqa: ARG001
            captured["prompt"] = prompt
            return '{"test_file_content": "package shop", "test_file_path": "x_test.go", "tests_generated": 1, "generated_tests": []}'

        monkeypatch.setattr(TestGeneratorAgent, "_generate_with_events", fake_generate)
        result = TestGeneratorAgent().generate_tdd_tests(
            {"description": "sum a cart", "language": None, "snippet_type": "function"},
            project_path=str(tmp_path),
        )

        assert (
            "Generate failing tests for not-yet-implemented go code"
            in captured["prompt"]
        )
        assert result.tests_generated == 1

    def test_the_coverage_target_reaches_the_unit_prompt(self, tmp_path: Path):
        info = {"language": "python", "test_framework": "pytest", "project_root": ""}
        prompt = TestGeneratorAgent()._generate_unit_prompt(
            "def f(): pass", str(tmp_path / "f.py"), info, "", 3, "", 95
        )

        assert "Target line coverage for this file: 95%" in prompt


class TestLibrariesForEveryStack:
    def test_go_mod_names_testify(self, tmp_path: Path):
        _write(
            tmp_path / "go.mod", "require (\n\tgithub.com/stretchr/testify v1.9.0\n)\n"
        )

        installed = detect_installed(tmp_path, "go")

        assert "github.com/stretchr/testify" in installed
        selection = resolve_selection(tmp_path, "go")
        assert selection.ids() == ["testify"]

    def test_pubspec_keys_not_words(self, tmp_path: Path):
        _write(
            tmp_path / "pubspec.yaml",
            "description: a test app\ndev_dependencies:\n  mocktail: ^1.0.0\n",
        )

        installed = detect_installed(tmp_path, "dart")

        assert "mocktail" in installed
        assert "test" not in installed

    def test_missing_packages_become_the_ecosystem_command(self, tmp_path: Path):
        for language, command in [
            ("rust", "cargo add --dev pretty_assertions mockall"),
            ("php", "composer require --dev phpunit/phpunit mockery/mockery"),
            ("ruby", "bundle add rspec --group test"),
            ("dart", "dart pub add --dev test mocktail"),
        ]:
            assert command in install_commands(resolve_selection(tmp_path, language))


def _load_runner():
    spec = importlib.util.spec_from_file_location("tg_runner_stacks", RUNNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class TestRunnerLanguage:
    class _Args:
        def __init__(self, language=None, project_path=None):
            self.language = language
            self.project_path = project_path

    def test_a_named_language_beats_the_last_open_file(self, tmp_path: Path):
        runner = _load_runner()
        args = self._Args("csharp", str(tmp_path))

        assert runner._resolve_language(args, "src/app.py") == "csharp"

    def test_without_a_file_the_project_decides(self, tmp_path: Path):
        runner = _load_runner()
        _write(tmp_path / "Cargo.toml", "[package]\n")

        assert runner._resolve_language(self._Args(None, str(tmp_path)), "") == "rust"
        assert runner._resolve_language(self._Args(None, None), "") == "python"
