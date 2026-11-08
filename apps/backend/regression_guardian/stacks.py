"""Regression tests on every stack: pick the framework, write the other skeletons.

The incident says which file failed; the file's language and the project's
manifests say which test framework the regression test belongs to. The
skeletons that ``test_generator`` does not write (PHPUnit, RSpec, Dart, XCTest,
NUnit, TestNG) live here.

Incident text comes from an APM payload, so it is data: ``safe_text`` keeps it
on one line and away from quotes and comment terminators before any template
puts it inside generated code.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path

from .incident_parser import Incident
from .test_generator import GeneratedTest, TestFramework, _safe_function_name

_UNSAFE = re.compile(r"[^\w .,:;()\[\]=+\-#@!?%&|^~/]")
_SPACES = re.compile(r"\s+")


def safe_text(value: str | None, limit: int = 200) -> str:
    """One line of incident text that no template can turn into code."""
    if not value:
        return ""
    text = _UNSAFE.sub(" ", value.replace("\\", "/"))
    return _SPACES.sub(" ", text).strip()[:limit]


def sanitized(incident: Incident) -> Incident:
    """The incident with every field a template interpolates made safe."""
    return replace(
        incident,
        id=safe_text(incident.id, 80),
        title=safe_text(incident.title),
        exception_type=safe_text(incident.exception_type, 120),
        exception_message=safe_text(incident.exception_message),
        stack_frames=[
            replace(
                frame,
                file=safe_text(frame.file, 300),
                function=safe_text(frame.function, 120),
                context=safe_text(frame.context),
            )
            for frame in incident.stack_frames
        ],
    )


# --- Framework detection ------------------------------------------------------

_BY_EXTENSION: dict[str, TestFramework] = {
    ".py": TestFramework.PYTEST,
    ".go": TestFramework.GO_TEST,
    ".rs": TestFramework.CARGO_TEST,
    ".php": TestFramework.PHPUNIT,
    ".rb": TestFramework.RSPEC,
    ".dart": TestFramework.DART_TEST,
    ".swift": TestFramework.XCTEST,
}
_JS = {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".vue", ".svelte"}
_JVM = {".java", ".kt", ".kts", ".scala", ".groovy"}
_DOTNET = {".cs", ".fs", ".vb", ".razor", ".cshtml"}
_SKIPPED_DIRS = {
    "node_modules",
    ".git",
    "bin",
    "obj",
    "target",
    "vendor",
    ".venv",
    "dist",
    "build",
}


def _project_files(root: Path, depth: int = 2) -> list[Path]:
    found: list[Path] = []
    frontier = [root]
    for _ in range(depth):
        nxt: list[Path] = []
        for folder in frontier:
            try:
                entries = list(folder.iterdir())
            except OSError:
                continue
            for entry in entries:
                if entry.is_dir() and entry.name not in _SKIPPED_DIRS:
                    nxt.append(entry)
                elif entry.is_file():
                    found.append(entry)
        frontier = nxt
    return found


def _mentions(files: list[Path], names: tuple[str, ...], needle: str) -> bool:
    for path in files:
        if path.name in names or path.suffix in names:
            try:
                if needle in path.read_text(encoding="utf-8", errors="ignore").lower():
                    return True
            except OSError:
                continue
    return False


def _js_framework(files: list[Path]) -> TestFramework:
    names = {p.name for p in files}
    if any(n.startswith("vitest.config") for n in names) or _mentions(
        files, ("package.json",), '"vitest"'
    ):
        return TestFramework.VITEST
    if any(n.startswith("jest.config") for n in names) or _mentions(
        files, ("package.json",), '"jest"'
    ):
        return TestFramework.JEST
    if any(n.startswith(".mocharc") for n in names):
        return TestFramework.MOCHA
    return TestFramework.JEST


def _family(suffix: str, files: list[Path]) -> TestFramework | None:
    if suffix in _JS:
        return _js_framework(files)
    if suffix in _JVM:
        builds = ("pom.xml", "build.gradle", "build.gradle.kts")
        return (
            TestFramework.TESTNG
            if _mentions(files, builds, "testng")
            else TestFramework.JUNIT5
        )
    if suffix in _DOTNET:
        projects = (".csproj", ".fsproj", ".vbproj", "Directory.Packages.props")
        return (
            TestFramework.NUNIT
            if _mentions(files, projects, "nunit")
            else TestFramework.XUNIT
        )
    return _BY_EXTENSION.get(suffix)


# Project markers, most specific first, for an incident without a faulting file.
_MARKERS: tuple[tuple[str, str], ...] = (
    ("Cargo.toml", ".rs"),
    ("go.mod", ".go"),
    ("pubspec.yaml", ".dart"),
    ("Package.swift", ".swift"),
    ("composer.json", ".php"),
    ("Gemfile", ".rb"),
    ("pom.xml", ".java"),
    ("build.gradle", ".java"),
    ("build.gradle.kts", ".kt"),
    ("package.json", ".ts"),
    ("pyproject.toml", ".py"),
    ("requirements.txt", ".py"),
    ("setup.py", ".py"),
)


def detect_framework(project_root: Path, faulting_file: str | None) -> TestFramework:
    """The test framework for an incident: its file's stack, else the project's."""
    files = _project_files(project_root)
    if faulting_file:
        found = _family(Path(faulting_file).suffix.lower(), files)
        if found:
            return found
    names = {p.name for p in files}
    if any(p.suffix in {".csproj", ".fsproj", ".vbproj", ".sln"} for p in files):
        return _family(".cs", files) or TestFramework.XUNIT
    for marker, suffix in _MARKERS:
        if marker in names:
            return _family(suffix, files) or TestFramework.PYTEST
    return TestFramework.PYTEST


# --- Skeletons for the remaining frameworks -----------------------------------


def _class_name(func: str) -> str:
    return "".join(word.title() for word in func.split("_")) or "Unknown"


def _result(
    incident: Incident, framework: TestFramework, name: str, code: str, path: str
) -> GeneratedTest:
    return GeneratedTest(
        incident_id=incident.id,
        framework=framework,
        test_name=name,
        test_code=code,
        file_path=path,
        target_file=incident.faulting_file or "",
        target_function=incident.faulting_function or "",
        tags=["regression", incident.source.value],
    )


def _phpunit(incident: Incident) -> GeneratedTest:
    func = _safe_function_name(incident)
    cls = _class_name(func)
    code = f"""<?php

use PHPUnit\\Framework\\TestCase;

/**
 * Regression test for incident {incident.id}.
 * Auto-generated by Regression Guardian.
 * {incident.exception_type}: {incident.exception_message}
 */
final class Regression{cls}Test extends TestCase
{{
    public function testRegression{cls}(): void
    {{
        $this->markTestSkipped('Skeleton test - fill in reproduction logic');
    }}
}}
"""
    return _result(
        incident,
        TestFramework.PHPUNIT,
        f"testRegression{cls}",
        code,
        f"tests/Regression/Regression{cls}Test.php",
    )


def _rspec(incident: Incident) -> GeneratedTest:
    func = _safe_function_name(incident)
    code = f"""# Regression test for incident {incident.id}.
# Auto-generated by Regression Guardian.
# {incident.exception_type}: {incident.exception_message}
RSpec.describe "Regression {func}" do
  it "handles the error condition" do
    skip "Skeleton test - fill in reproduction logic"
  end
end
"""
    return _result(
        incident,
        TestFramework.RSPEC,
        f"regression_{func}",
        code,
        f"spec/regression/incident_{func}_spec.rb",
    )


def _dart_test(incident: Incident) -> GeneratedTest:
    func = _safe_function_name(incident)
    code = f"""// Regression test for incident {incident.id}.
// Auto-generated by Regression Guardian.
// {incident.exception_type}: {incident.exception_message}
import 'package:test/test.dart';

void main() {{
  test('regression {func}', () {{
    // TODO: Reproduce the incident state
  }}, skip: 'Skeleton test - fill in reproduction logic');
}}
"""
    return _result(
        incident,
        TestFramework.DART_TEST,
        f"regression_{func}",
        code,
        f"test/regression/incident_{func}_test.dart",
    )


def _xctest(incident: Incident) -> GeneratedTest:
    func = _safe_function_name(incident)
    cls = _class_name(func)
    code = f"""// Regression test for incident {incident.id}.
// Auto-generated by Regression Guardian.
// {incident.exception_type}: {incident.exception_message}
import XCTest

final class Regression{cls}Tests: XCTestCase {{
    func testRegression{cls}() throws {{
        throw XCTSkip("Skeleton test - fill in reproduction logic")
    }}
}}
"""
    return _result(
        incident,
        TestFramework.XCTEST,
        f"testRegression{cls}",
        code,
        f"Tests/RegressionTests/Regression{cls}Tests.swift",
    )


def _nunit(incident: Incident) -> GeneratedTest:
    func = _safe_function_name(incident)
    cls = _class_name(func)
    code = f"""using NUnit.Framework;

/// <summary>
/// Regression test for incident {incident.id}.
/// Auto-generated by Regression Guardian.
/// {incident.exception_type}: {incident.exception_message}
/// </summary>
[TestFixture]
public class Regression{cls}Tests
{{
    [Test]
    [Ignore("Skeleton test - fill in reproduction logic")]
    public void TestRegression{cls}()
    {{
        Assert.Pass();
    }}
}}
"""
    return _result(
        incident,
        TestFramework.NUNIT,
        f"TestRegression{cls}",
        code,
        f"Tests/Regression/Regression{cls}Tests.cs",
    )


def _testng(incident: Incident) -> GeneratedTest:
    func = _safe_function_name(incident)
    cls = _class_name(func)
    code = f"""package regression;

import org.testng.annotations.Test;

/**
 * Regression test for incident {incident.id}.
 * Auto-generated by Regression Guardian.
 * {incident.exception_type}: {incident.exception_message}
 */
public class Regression{cls}Test {{

    @Test(enabled = false, description = "Skeleton test - fill in reproduction logic")
    public void testRegression{cls}() {{
    }}
}}
"""
    return _result(
        incident,
        TestFramework.TESTNG,
        f"testRegression{cls}",
        code,
        f"src/test/java/regression/Regression{cls}Test.java",
    )


EXTRA_GENERATORS: dict[TestFramework, Callable[[Incident], GeneratedTest]] = {
    TestFramework.PHPUNIT: _phpunit,
    TestFramework.RSPEC: _rspec,
    TestFramework.DART_TEST: _dart_test,
    TestFramework.XCTEST: _xctest,
    TestFramework.NUNIT: _nunit,
    TestFramework.TESTNG: _testng,
}
