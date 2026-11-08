"""Which language a project is written in, and which test framework it uses.

The generator used to answer this with a chain of detectors that each looked
at one manifest and ignored the language of the file being tested: the first
one to find *something* won. A C# file in a solution with a ``package.json``
for its front end came back as "vitest", and a ``requirements.txt`` beside a
Go service made it "pytest". The model then wrote a Vitest file for a C#
class.

Here the language comes first and only that language's manifests are read.
Every rule is data — manifest patterns and the substrings that name a
framework — so supporting another stack is a table entry, not a new branch.
Nothing here calls a model or runs a tool: it reads files, and only the
manifests ``project.test_stack.iter_project_files`` finds under the root.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from project.test_stack import iter_project_files, read_manifest

#: Source extension → language. Mirrors what the file picker offers.
LANGUAGE_BY_EXTENSION: dict[str, str] = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".vue": "javascript",
    ".svelte": "javascript",
    ".cs": "csharp",
    ".java": "java",
    ".kt": "kotlin",
    ".kts": "kotlin",
    ".go": "go",
    ".rs": "rust",
    ".rb": "ruby",
    ".php": "php",
    ".swift": "swift",
    ".dart": "dart",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
}

#: Every language the generator writes tests for, in the order the UI lists
#: them. ``tests/test_test_generation_stacks.py`` keeps the renderer's TDD
#: language list in step with it.
SUPPORTED_LANGUAGES: tuple[str, ...] = (
    "typescript",
    "javascript",
    "python",
    "csharp",
    "java",
    "kotlin",
    "go",
    "rust",
    "php",
    "ruby",
    "swift",
    "dart",
    "c",
    "cpp",
)

#: What a language tests with when the project says nothing.
DEFAULT_UNIT_FRAMEWORK: dict[str, str] = {
    "python": "pytest",
    "typescript": "jest",
    "javascript": "jest",
    "csharp": "xunit",
    "java": "junit5",
    "kotlin": "junit5",
    "go": "testing",
    "rust": "built-in",
    "ruby": "rspec",
    "php": "phpunit",
    "swift": "xctest",
    "dart": "test",
    "c": "unity",
    "cpp": "googletest",
}

#: What an end-to-end scenario runs on when the project says nothing.
DEFAULT_E2E_FRAMEWORK: dict[str, str] = {
    "python": "playwright",
    "typescript": "playwright",
    "javascript": "playwright",
    "csharp": "playwright",
    "java": "playwright",
    "kotlin": "playwright",
    "go": "playwright-go",
    "rust": "thirtyfour",
    "ruby": "capybara",
    "php": "dusk",
    "swift": "xcuitest",
    "dart": "integration_test",
    "c": "unity",
    "cpp": "googletest",
}


@dataclass(frozen=True)
class _Rule:
    """A lowercase substring that, found in a manifest, names a framework."""

    needle: str
    framework: str
    label: str


#: Manifests read per language. ``file:<name>`` needles match a file's
#: presence (``pytest.ini``, ``conftest.py``) rather than its content.
_MANIFESTS: dict[str, tuple[str, ...]] = {
    "python": (
        "requirements*.txt",
        "pyproject.toml",
        "setup.cfg",
        "Pipfile",
        "tox.ini",
        "pytest.ini",
        "conftest.py",
    ),
    "typescript": ("package.json",),
    "javascript": ("package.json",),
    "csharp": ("*.csproj", "*.fsproj", "Directory.Packages.props", "packages.config"),
    "java": ("pom.xml", "build.gradle", "build.gradle.kts"),
    "kotlin": ("build.gradle.kts", "build.gradle", "pom.xml"),
    "go": ("go.mod",),
    "rust": ("Cargo.toml",),
    "ruby": ("Gemfile", "*.gemspec"),
    "php": ("composer.json",),
    "swift": ("Package.swift", "Podfile"),
    "dart": ("pubspec.yaml",),
    "c": (
        "CMakeLists.txt",
        "conanfile.txt",
        "conanfile.py",
        "vcpkg.json",
        "meson.build",
    ),
    "cpp": (
        "CMakeLists.txt",
        "conanfile.txt",
        "conanfile.py",
        "vcpkg.json",
        "meson.build",
    ),
}

_JS_UNIT = (
    _Rule('"vitest"', "vitest", "Vitest"),
    _Rule('"jest"', "jest", "Jest"),
    _Rule('"mocha"', "mocha", "Mocha"),
    _Rule('"jasmine', "jasmine", "Jasmine"),
    _Rule('"ava"', "ava", "AVA"),
)
_JS_E2E = (
    _Rule('"@playwright/test"', "playwright", "Playwright"),
    _Rule('"cypress"', "cypress", "Cypress"),
    _Rule('"@wdio/cli"', "webdriverio", "WebdriverIO"),
    _Rule('"puppeteer"', "puppeteer", "Puppeteer"),
)
_JVM_UNIT = (
    _Rule("io.kotest", "kotest", "Kotest"),
    _Rule("junit-jupiter", "junit5", "JUnit 5"),
    _Rule("org.junit.jupiter", "junit5", "JUnit 5"),
    _Rule("spring-boot-starter-test", "junit5", "JUnit 5 (Spring Boot)"),
    _Rule("testng", "testng", "TestNG"),
    _Rule("junit", "junit4", "JUnit 4"),
)
_JVM_E2E = (
    _Rule("com.microsoft.playwright", "playwright", "Playwright"),
    _Rule("selenide", "selenide", "Selenide"),
    _Rule("selenium", "selenium", "Selenium"),
    _Rule("androidx.test.espresso", "espresso", "Espresso"),
)
_NATIVE_UNIT = (
    _Rule("gtest", "googletest", "GoogleTest"),
    _Rule("googletest", "googletest", "GoogleTest"),
    _Rule("catch2", "catch2", "Catch2"),
    _Rule("doctest", "doctest", "doctest"),
    _Rule("cmocka", "cmocka", "cmocka"),
    _Rule("throwtheswitch", "unity", "Unity"),
)

_UNIT_RULES: dict[str, tuple[_Rule, ...]] = {
    "python": (
        _Rule("pytest", "pytest", "pytest"),
        _Rule("file:pytest.ini", "pytest", "pytest"),
        _Rule("file:conftest.py", "pytest", "pytest"),
        _Rule("nose2", "nose2", "nose2"),
        _Rule("unittest", "unittest", "unittest"),
    ),
    "typescript": _JS_UNIT,
    "javascript": _JS_UNIT,
    "csharp": (
        _Rule('include="tunit', "tunit", "TUnit"),
        _Rule('include="xunit', "xunit", "xUnit"),
        _Rule('id="xunit', "xunit", "xUnit"),
        _Rule('include="nunit', "nunit", "NUnit"),
        _Rule('id="nunit', "nunit", "NUnit"),
        _Rule("mstest", "mstest", "MSTest"),
    ),
    "java": _JVM_UNIT,
    "kotlin": _JVM_UNIT,
    "go": (
        _Rule("github.com/onsi/ginkgo", "ginkgo", "Ginkgo"),
        _Rule("github.com/stretchr/testify", "testify", "testing + testify"),
    ),
    "rust": (
        _Rule("rstest", "rstest", "rstest"),
        _Rule("proptest", "proptest", "proptest"),
    ),
    "ruby": (
        _Rule("rspec", "rspec", "RSpec"),
        _Rule("minitest", "minitest", "Minitest"),
    ),
    "php": (
        _Rule("pestphp/pest", "pest", "Pest"),
        _Rule("phpunit/phpunit", "phpunit", "PHPUnit"),
        _Rule("codeception/codeception", "codeception", "Codeception"),
    ),
    "swift": (
        _Rule("github.com/quick/quick", "quick", "Quick + Nimble"),
        _Rule("swift-testing", "swift-testing", "Swift Testing"),
    ),
    "dart": (
        _Rule("flutter_test", "flutter_test", "flutter_test"),
        _Rule("\n  test:", "test", "package:test"),
    ),
    "c": _NATIVE_UNIT,
    "cpp": _NATIVE_UNIT,
}

_E2E_RULES: dict[str, tuple[_Rule, ...]] = {
    "python": (
        _Rule("playwright", "playwright", "Playwright"),
        _Rule("selenium", "selenium", "Selenium"),
        _Rule("behave", "behave", "behave"),
    ),
    "typescript": _JS_E2E,
    "javascript": _JS_E2E,
    "csharp": (
        _Rule('include="microsoft.playwright', "playwright", "Playwright"),
        _Rule('include="reqnroll', "reqnroll", "Reqnroll"),
        _Rule('include="specflow', "specflow", "SpecFlow"),
        _Rule('include="selenium', "selenium", "Selenium"),
        _Rule('include="flaui', "flaui", "FlaUI"),
    ),
    "java": _JVM_E2E,
    "kotlin": _JVM_E2E,
    "go": (
        _Rule(
            "github.com/playwright-community/playwright-go",
            "playwright-go",
            "playwright-go",
        ),
        _Rule("github.com/chromedp/chromedp", "chromedp", "chromedp"),
    ),
    "rust": (
        _Rule("thirtyfour", "thirtyfour", "thirtyfour"),
        _Rule("fantoccini", "fantoccini", "fantoccini"),
    ),
    "ruby": (
        _Rule("capybara", "capybara", "Capybara"),
        _Rule("cucumber", "cucumber", "Cucumber"),
    ),
    "php": (
        _Rule("laravel/dusk", "dusk", "Laravel Dusk"),
        _Rule("codeception/codeception", "codeception", "Codeception"),
        _Rule("symfony/panther", "panther", "Symfony Panther"),
    ),
    "swift": (),
    "dart": (
        _Rule("integration_test", "integration_test", "integration_test"),
        _Rule("patrol", "patrol", "Patrol"),
    ),
    "c": _NATIVE_UNIT,
    "cpp": _NATIVE_UNIT,
}

#: Root manifests, in the order they decide a mixed repository's language. A
#: back end comes before ``package.json``, which so many repositories carry
#: for tooling alone.
_LANGUAGE_MARKERS: tuple[tuple[str, str], ...] = (
    ("*.sln", "csharp"),
    ("*.slnx", "csharp"),
    ("*.csproj", "csharp"),
    ("go.mod", "go"),
    ("Cargo.toml", "rust"),
    ("pubspec.yaml", "dart"),
    ("Package.swift", "swift"),
    ("composer.json", "php"),
    ("Gemfile", "ruby"),
    ("pom.xml", "java"),
    ("build.gradle.kts", "kotlin"),
    ("build.gradle", "java"),
    ("pyproject.toml", "python"),
    ("setup.py", "python"),
    ("requirements.txt", "python"),
    ("Pipfile", "python"),
    ("package.json", "javascript"),
    ("CMakeLists.txt", "cpp"),
)


def language_for_path(file_path: str) -> str:
    """The language of *file_path* from its extension, or ``"unknown"``."""
    return LANGUAGE_BY_EXTENSION.get(Path(file_path).suffix.lower(), "unknown")


def detect_project_language(project_root: str | Path | None) -> str | None:
    """The language a project is mostly written in, from its manifests.

    Used where there is no source file to read an extension from: an E2E
    scenario typed as text, a TDD run before the code exists. Root manifests
    decide first; a repository whose manifests all live one level down
    (``apps/api``, ``src/Web``) is read from there. ``None`` when nothing
    says.
    """
    if not project_root:
        return None
    root = Path(project_root)
    if not root.is_dir():
        return None
    for depth_root in (root, *_children(root)):
        for pattern, language in _LANGUAGE_MARKERS:
            if any(depth_root.glob(pattern)):
                return _refine(depth_root, language)
    return None


def _children(root: Path) -> list[Path]:
    try:
        return sorted(
            entry
            for entry in root.iterdir()
            if entry.is_dir()
            and not entry.name.startswith(".")
            and entry.name
            not in {"node_modules", "bin", "obj", "dist", "build", "vendor"}
        )[:30]
    except OSError:
        return []


def _refine(root: Path, language: str) -> str:
    """Split the families a single manifest cannot tell apart."""
    if language == "javascript" and (
        (root / "tsconfig.json").exists()
        or '"typescript"' in read_manifest(root / "package.json")
    ):
        return "typescript"
    if language == "java" and "kotlin" in read_manifest(root / "build.gradle").lower():
        return "kotlin"
    if language == "cpp":
        if any(root.glob("*.c")) and not any(root.glob("*.cpp")):
            return "c"
    return language


def _manifest_blob(project_root: Path, language: str) -> tuple[str, str]:
    """Every manifest of *language* under the root, lowercased, and the first name."""
    patterns = _MANIFESTS.get(language, ())
    if not patterns:
        return "", ""
    files = iter_project_files(project_root, patterns)
    parts: list[str] = []
    for path in files:
        parts.append(f"file:{path.name.lower()}")
        parts.append(read_manifest(path).lower())
    return "\n".join(parts), files[0].name if files else ""


def detect_framework(
    project_root: str | Path | None,
    language: str,
    kind: str = "unit",
) -> tuple[str, str]:
    """``(framework, details)`` for *language* in the project, never ``None``.

    Only *language*'s manifests are read, so a ``package.json`` beside a
    solution cannot turn a C# file into a Vitest one. ``details`` names the
    manifest that decided, or is empty when the default was used.
    """
    defaults = DEFAULT_E2E_FRAMEWORK if kind == "e2e" else DEFAULT_UNIT_FRAMEWORK
    default = defaults.get(language, "unknown")
    if not project_root or not Path(project_root).is_dir():
        return default, ""
    rules = (_E2E_RULES if kind == "e2e" else _UNIT_RULES).get(language, ())
    if not rules:
        return default, ""
    blob, first = _manifest_blob(Path(project_root), language)
    if not blob:
        return default, ""
    for rule in rules:
        if rule.needle in blob:
            return rule.framework, f"{rule.label} ({first})" if first else rule.label
    return default, ""


def suggested_test_path(language: str, stem: str, kind: str = "unit") -> str:
    """The relative path the model is asked to propose for a new test file.

    Only a suggestion: unit and TDD files are placed by ``layout``, which keeps
    the *name*. The name is the part that matters — it carries the extension
    and the framework's convention, so a C# scenario must not be asked for as
    ``e2e/test_x.js``, which is what the prompts used to ask for.
    """
    from test_generation.layout import _pascal, conventional_test_file_name

    ext_by_language = {
        "python": ".py",
        "typescript": ".ts",
        "javascript": ".js",
        "csharp": ".cs",
        "java": ".java",
        "kotlin": ".kt",
        "go": ".go",
        "rust": ".rs",
        "ruby": ".rb",
        "php": ".php",
        "swift": ".swift",
        "dart": ".dart",
        "c": ".c",
        "cpp": ".cpp",
    }
    ext = ext_by_language.get(language, "")
    if kind == "e2e":
        pascal = _pascal(stem)
        return {
            "python": f"e2e/test_{stem}.py",
            "typescript": f"e2e/{stem}.spec.ts",
            "javascript": f"e2e/{stem}.spec.js",
            "csharp": f"e2e/{pascal}E2ETests.cs",
            "java": f"e2e/{pascal}E2ETest.java",
            "kotlin": f"e2e/{pascal}E2ETest.kt",
            "go": f"e2e/{stem}_e2e_test.go",
            "rust": f"tests/{stem}_e2e.rs",
            "ruby": f"spec/features/{stem}_spec.rb",
            "php": f"tests/Browser/{pascal}Test.php",
            "swift": f"UITests/{pascal}UITests.swift",
            "dart": f"integration_test/{stem}_test.dart",
            "c": f"tests/test_{stem}_e2e.c",
            "cpp": f"tests/{stem}_e2e_test.cpp",
        }.get(language, f"e2e/test_{stem}{ext}")
    folder = {
        "ruby": "spec",
        "dart": "test",
        "swift": "Tests",
        "java": "src/test/java",
        "kotlin": "src/test/kotlin",
    }.get(language, "tests")
    name = conventional_test_file_name(f"{stem}{ext}", language)
    if language in {"go", "rust"}:
        return name
    return f"{folder}/{name}"
