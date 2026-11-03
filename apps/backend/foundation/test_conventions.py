"""Test naming conventions of the languages beyond Python and TypeScript.

`foundation.touched_tests` maps a changed source file to its tests from file
names only. Python and TypeScript/JavaScript live there; this module holds the
other ecosystems, each with the convention its own tooling and templates
create, so a WorkPilot task on a .NET, Java, Go or Flutter repository gets the
targeted review too instead of always paying for the full one:

=====================  ==========================================  ===================================
Ecosystem              Source                                      Test it maps to
=====================  ==========================================  ===================================
.NET (C#, F#, VB),     ``Services/Foo.cs``, ``Pages/Counter.razor``  ``FooTests.cs`` / ``FooTest.cs``
Blazor, MAUI/WPF       (code-behind ``Counter.razor.cs`` too)      (bUnit: ``CounterTests.razor``)
Java, Kotlin, Scala,   ``src/main/java/x/Foo.java``                ``src/test/java/x/FooTest.java``,
Groovy (Android, KMP)                                              ``FooTests``, ``FooIT``, ``FooSpec``
Go                     ``pkg/foo.go``                              ``pkg/foo_test.go`` (same package)
Rust                   ``src/foo.rs``                              ``tests/foo.rs``, ``src/foo/tests.rs``,
                                                                   ``foo_test.rs``, or its own
                                                                   ``#[cfg(test)]`` module
PHP (PHPUnit, Pest)    ``app/Foo.php``                             ``tests/**/FooTest.php``
Swift                  ``Sources/Lib/Foo.swift``                   ``Tests/LibTests/FooTests.swift``
Dart / Flutter         ``lib/src/foo.dart``                        ``test/**/foo_test.dart``,
                                                                   ``integration_test/foo_test.dart``
Ruby                   ``app/models/foo.rb``                       ``spec/**/foo_spec.rb``,
                                                                   ``test/**/foo_test.rb``
Elixir                 ``lib/foo.ex``                              ``test/**/foo_test.exs``
C / C++                ``src/foo.cpp``, ``foo.h``                  ``foo_test.cc``, ``foo_unittest.cc``,
                                                                   ``test_foo.c``
=====================  ==========================================  ===================================

A test counts next to its source or inside a test directory at the source's
level or above it: ``tests/``, ``test/``, ``spec/``, a ``*.Tests`` .NET
project, a ``*Tests`` Swift/Xcode target, Maven's ``src/test``, Android's
``androidTest``, Kotlin Multiplatform's ``commonTest``. A file whose name is
not a test by its language's convention is never one, so a helper inside a
test project leaves its change to the full review.

These languages run tests by class, package or target rather than by path
(``dotnet test --filter``, ``mvn -Dtest=``, ``go test ./pkg``,
``cargo test --test``), so `run_evidence` gives `qa.targeted_gate` what a
command that ran the test names: the test's class/file stem, or its directory.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import PurePosixPath


@dataclass(frozen=True)
class Convention:
    """How one ecosystem names its tests."""

    name: str
    #: Extensions of the source files the convention maps.
    sources: frozenset[str]
    #: Extensions a test file of the ecosystem has.
    tests: frozenset[str]
    #: Test stems the source stem ``s`` maps to: ``("{s}Tests", "{s}Test")``.
    patterns: tuple[str, ...]
    #: Whether a test next to its source counts (Go: only there).
    same_dir: bool = True
    #: Whether a test inside a test directory at or above the source counts.
    test_dir: bool = True
    #: Text that marks tests written inside the source itself (Rust).
    inline_marker: str | None = None

    def is_test_stem(self, stem: str) -> bool:
        for pattern in self.patterns:
            head, _, tail = pattern.partition("{s}")
            if len(stem) <= len(head) + len(tail) or not stem.startswith(head):
                continue
            if not stem.endswith(tail):
                continue
            # ``FooIT`` is a Failsafe test, ``SPLIT`` is not.
            if tail.isupper() and len(tail) <= 2 and stem[-len(tail) - 1].isupper():
                continue
            return True
        return False

    def candidates(self, stem: str) -> frozenset[str]:
        return frozenset(p.replace("{s}", stem) for p in self.patterns)


CONVENTIONS: tuple[Convention, ...] = (
    Convention(
        ".NET",
        frozenset({".cs", ".fs", ".vb", ".razor"}),
        frozenset({".cs", ".fs", ".vb", ".razor"}),
        ("{s}Tests", "{s}Test"),
    ),
    Convention(
        "JVM",
        frozenset({".java", ".kt", ".scala", ".groovy"}),
        frozenset({".java", ".kt", ".scala", ".groovy"}),
        ("{s}Test", "{s}Tests", "{s}IT", "{s}Spec"),
    ),
    Convention(
        "Go", frozenset({".go"}), frozenset({".go"}), ("{s}_test",), test_dir=False
    ),
    Convention(
        "Rust",
        frozenset({".rs"}),
        frozenset({".rs"}),
        ("{s}_test", "{s}_tests"),
        inline_marker="#[cfg(test)]",
    ),
    Convention("PHP", frozenset({".php"}), frozenset({".php"}), ("{s}Test",)),
    Convention(
        "Swift", frozenset({".swift"}), frozenset({".swift"}), ("{s}Tests", "{s}Test")
    ),
    Convention("Dart", frozenset({".dart"}), frozenset({".dart"}), ("{s}_test",)),
    Convention(
        "Ruby",
        frozenset({".rb"}),
        frozenset({".rb"}),
        ("{s}_spec", "{s}_test", "test_{s}"),
    ),
    Convention(
        "Elixir", frozenset({".ex", ".exs"}), frozenset({".exs"}), ("{s}_test",)
    ),
    Convention(
        "C/C++",
        frozenset({".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp"}),
        frozenset({".c", ".cc", ".cpp", ".cxx"}),
        ("{s}_test", "{s}_unittest", "test_{s}"),
    ),
)

#: Source extensions of all the conventions above.
SOURCE_EXTENSIONS = frozenset(e for c in CONVENTIONS for e in c.sources)

#: Inner suffixes of code-behind files: ``Counter.razor.cs`` is ``Counter``.
_CODE_BEHIND = (".razor", ".xaml", ".cshtml")

#: Directory names that hold tests in every ecosystem.
_TEST_DIR_NAMES = frozenset(
    {"test", "tests", "spec", "specs", "__tests__", "integration_test", "test_driver"}
)


def is_test_dir(name: str) -> bool:
    """True for a directory of tests: ``tests``, ``MyApp.Tests``, ``androidTest``.

    The PascalCase/camelCase ``...Test(s)`` form (``MyLibTests``,
    ``commonTest``) needs its capital T, so ``latest/`` is not one.
    """
    lower = name.lower()
    if lower in _TEST_DIR_NAMES or lower.endswith((".tests", ".test")):
        return True
    return len(name) > 5 and name.endswith(("Test", "Tests"))


def convention_for(path: str) -> Convention | None:
    suffix = PurePosixPath(path).suffix.lower()
    for convention in CONVENTIONS:
        if suffix in convention.sources or suffix in convention.tests:
            return convention
    return None


def _stem(p: PurePosixPath) -> str:
    stem = p.stem
    for inner in _CODE_BEHIND:
        if stem.lower().endswith(inner):
            return stem[: -len(inner)]
    return stem


def _rust_is_test(p: PurePosixPath) -> bool:
    return p.name == "tests.rs" or (len(p.parts) > 1 and p.parts[-2] == "tests")


def is_test(path: PurePosixPath) -> bool:
    """True when ``path`` is a test by its ecosystem's naming convention."""
    convention = convention_for(str(path))
    if convention is None or path.suffix.lower() not in convention.tests:
        return False
    if convention.name == "Rust" and _rust_is_test(path):
        return True
    return convention.is_test_stem(path.stem)


def _within(test: PurePosixPath, source_dir: PurePosixPath) -> bool:
    """``test`` lies in a test directory at ``source_dir``'s level or above."""
    parts = test.parts[:-1]
    for i, part in enumerate(parts):
        if is_test_dir(part):
            anchor = parts[:i]
            if tuple(source_dir.parts[: len(anchor)]) == tuple(anchor):
                return True
    return False


def _rust_matches(source: PurePosixPath, test: PurePosixPath, stem: str) -> bool:
    if test.name == "tests.rs":
        return test.parent == source.parent / stem
    if test.parent.name == "tests" and test.stem in {stem, f"{stem}_test"}:
        return _within(test, source.parent)
    return False


def matches(source: PurePosixPath, test: PurePosixPath) -> bool:
    """True when ``test`` (already a test) is one of ``source``'s tests."""
    convention = convention_for(str(source))
    if convention is None or test.suffix.lower() not in convention.tests:
        return False
    stem = _stem(source)
    if convention.name == "Rust" and _rust_matches(source, test, stem):
        return True
    if test.stem not in convention.candidates(stem):
        return False
    if convention.same_dir and test.parent == source.parent:
        return True
    return convention.test_dir and _within(test, source.parent)


def inline_marker(path: str) -> str | None:
    """The text that shows ``path`` holds its own tests, for its language."""
    convention = convention_for(path)
    return convention.inline_marker if convention else None


def runs_by_name(path: str) -> bool:
    """True when the test at ``path`` is run by class, package or target."""
    return convention_for(path) is not None


def run_evidence(test: str) -> re.Pattern[str]:
    """What a command that ran ``test`` names besides its path.

    The test's stem as a whole word (the class of ``--filter FooTests``,
    ``-Dtest=FooTest``, ``--tests x.FooTest``, ``--test foo``, the module of
    ``cargo test foo``), or its directory or an enclosing test directory
    (``go test ./pkg/foo``, ``dotnet test tests/App.Tests``).
    """
    p = PurePosixPath(test)
    dirs = [str(p.parent)] if len(p.parts) > 1 else []
    dirs += [
        str(PurePosixPath(*p.parts[: i + 1]))
        for i in range(len(p.parts) - 1)
        if is_test_dir(p.parts[i])
    ]
    stem = re.escape(_stem(p))
    words = [rf"(?<![A-Za-z0-9_]){stem}(?![A-Za-z0-9_])"]
    words += [
        rf"(?:^|[\s\"'=])(?:\./)?{re.escape(d)}(?:/(?:\.\.\.)?)?(?=$|[\s\"';])"
        for d in dict.fromkeys(dirs)
    ]
    return re.compile("|".join(words))


#: Run-and-coverage examples per ecosystem, for the targeted reviewer prompt.
#: ``{tests}`` is the test files, ``{names}`` their class/file stems,
#: ``{dirs}`` their directories.
RUN_EXAMPLES: dict[str, str] = {
    ".NET": (
        "# .NET (xUnit/NUnit/MSTest, bUnit for Blazor): coverlet collector\n"
        'dotnet test <test project> --filter "{filter}" '
        '--collect:"XPlat Code Coverage"'
    ),
    "JVM": (
        "# Java/Kotlin/Scala (JUnit, Kotest, Spock): JaCoCo or Kover report\n"
        "mvn -Dtest={csv} test jacoco:report\n"
        "./gradlew test {gradle} jacocoTestReport   # or koverReport"
    ),
    "Go": "# Go\ngo test {go_dirs} -cover -coverprofile=cover.out",
    "Rust": (
        "# Rust: a source listed as its own test holds a #[cfg(test)] module\n"
        "cargo llvm-cov --summary-only -- {names}   # or cargo tarpaulin; "
        "cargo test {names} runs them"
    ),
    "PHP": (
        "# PHP (PHPUnit / Pest)\n"
        "vendor/bin/phpunit {tests} --coverage-text   # or vendor/bin/pest --coverage"
    ),
    "Swift": (
        "# Swift (XCTest / Swift Testing)\n"
        "swift test --filter {names_pipe} --enable-code-coverage"
    ),
    "Dart": "# Dart / Flutter\nflutter test {tests} --coverage   # or dart test",
    "Ruby": (
        "# Ruby (RSpec / Minitest, SimpleCov)\n"
        "bundle exec rspec {tests}   # or bin/rails test {tests}"
    ),
    "Elixir": "# Elixir\nmix test {tests} --cover",
    "C/C++": (
        "# C/C++ (GoogleTest, Catch2, CTest): build the test target, then\n"
        'ctest -R "{names_pipe}" --output-on-failure   # coverage: gcovr / llvm-cov'
    ),
}


def run_examples(tests: list[str]) -> list[str]:
    """The run-and-coverage example of each ecosystem among ``tests``."""
    by_convention: dict[str, list[str]] = {}
    for test in tests:
        convention = convention_for(test)
        if convention is not None:
            by_convention.setdefault(convention.name, []).append(test)
    examples = []
    for name, group in by_convention.items():
        names = list(dict.fromkeys(_stem(PurePosixPath(t)) for t in group))
        dirs = list(dict.fromkeys(str(PurePosixPath(t).parent) for t in group))
        examples.append(
            RUN_EXAMPLES[name].format(
                tests=" ".join(group),
                names=" ".join(names),
                names_pipe="|".join(names),
                csv=",".join(names),
                filter="|".join(f"FullyQualifiedName~{n}" for n in names),
                gradle=" ".join(f"--tests '*{n}'" for n in names),
                go_dirs=" ".join(f"./{d}" for d in dirs),
            )
        )
    return examples
