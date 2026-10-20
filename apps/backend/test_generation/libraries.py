"""Which test libraries the generated tests are written against.

A generated C# test is only useful if it is written in the idiom the project
tests in. Asked for a test with no further instruction, a model picks whichever
assertion style it saw most often — usually bare `Assert.Equal` — so a solution
that standardised on FluentAssertions and Moq got tests it had to rewrite by
hand, and a solution that had neither got tests that do not compile.

Two facts settle it, and neither needs a model:

* what the project **already references** — read from `.csproj`,
  `packages.config`, `package.json`, `requirements*.txt`, `pyproject.toml`;
* what the user **chose** for this run, which is the answer when the project
  has nothing to say yet.

`resolve_selection` merges the two into the list the prompt is built from, and
`missing_packages` says which of the chosen ones are not installed — the answer
to "why does this file not compile?" before the question is asked.

Nothing here runs a package manager. Installing is a separate, explicit action
(`install_commands` renders the commands, the runner's `add-packages` action
runs them) because adding a dependency to someone's solution is not a side
effect a generation should have.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from test_generation.stack_aware import iter_project_files, read_manifest

# Package ecosystems, which decide how a package is installed and named.
NUGET = "nuget"
NPM = "npm"
PYPI = "pypi"
MAVEN = "maven"


@dataclass(frozen=True)
class TestLibrary:
    """One library the user can put behind their generated tests."""

    id: str
    name: str
    package: str
    ecosystem: str
    language: str
    # framework | assertions | mocking | data | snapshot | http | ui | coverage
    category: str
    # One line, handed to the model. It says how to *write* with the library,
    # not what the library is: "FluentAssertions exists" changes nothing about
    # the generated file, "assert with result.Should().Be(...)" changes all of
    # it.
    usage: str
    # Offered pre-checked when the project references nothing at all.
    recommended: bool = False

    # Not a test class, whatever the name suggests to pytest's collector.
    __test__ = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


# The catalogue. Curated on purpose: a list of every test package on nuget.org
# is a search box, and a search box is what the user came here to avoid. What
# is here is what a .NET, Node, Python or Java project realistically tests with.
CATALOGUE: tuple[TestLibrary, ...] = (
    # ── .NET ─────────────────────────────────────────────────────────
    TestLibrary(
        "xunit",
        "xUnit",
        "xunit",
        NUGET,
        "csharp",
        "framework",
        "Use [Fact] and [Theory]/[InlineData]; the constructor is the setup and "
        "IDisposable the teardown — there is no [SetUp].",
        recommended=True,
    ),
    TestLibrary(
        "nunit",
        "NUnit",
        "NUnit",
        NUGET,
        "csharp",
        "framework",
        "Use [TestFixture], [Test], [TestCase], [SetUp] and [TearDown].",
    ),
    TestLibrary(
        "mstest",
        "MSTest",
        "MSTest.TestFramework",
        NUGET,
        "csharp",
        "framework",
        "Use [TestClass], [TestMethod], [DataRow] and [TestInitialize].",
    ),
    TestLibrary(
        "test-sdk",
        "Microsoft.NET.Test.Sdk",
        "Microsoft.NET.Test.Sdk",
        NUGET,
        "csharp",
        "framework",
        "Test host — required for `dotnet test` to discover the project; it "
        "changes nothing in the test code itself.",
        recommended=True,
    ),
    TestLibrary(
        "fluentassertions",
        "FluentAssertions",
        "FluentAssertions",
        NUGET,
        "csharp",
        "assertions",
        "Assert with result.Should().Be(...), .Should().BeEquivalentTo(...), "
        ".Should().Throw<T>().WithMessage(...) — never Assert.Equal.",
        recommended=True,
    ),
    TestLibrary(
        "shouldly",
        "Shouldly",
        "Shouldly",
        NUGET,
        "csharp",
        "assertions",
        "Assert with result.ShouldBe(...), Should.Throw<T>(() => ...).",
    ),
    TestLibrary(
        "moq",
        "Moq",
        "Moq",
        NUGET,
        "csharp",
        "mocking",
        "Mock dependencies with new Mock<T>(), .Setup(x => ...).Returns(...), "
        "and verify with .Verify(x => ..., Times.Once).",
        recommended=True,
    ),
    TestLibrary(
        "nsubstitute",
        "NSubstitute",
        "NSubstitute",
        NUGET,
        "csharp",
        "mocking",
        "Mock dependencies with Substitute.For<T>(), stub with "
        "x.Method().Returns(...), verify with x.Received().Method().",
    ),
    TestLibrary(
        "fakeiteasy",
        "FakeItEasy",
        "FakeItEasy",
        NUGET,
        "csharp",
        "mocking",
        "Mock dependencies with A.Fake<T>(), A.CallTo(() => ...).Returns(...), "
        "and A.CallTo(...).MustHaveHappened().",
    ),
    TestLibrary(
        "autofixture",
        "AutoFixture",
        "AutoFixture",
        NUGET,
        "csharp",
        "data",
        "Build test data with new Fixture().Create<T>() instead of hand-written "
        "object literals, so a test states only the values it cares about.",
    ),
    TestLibrary(
        "bogus",
        "Bogus",
        "Bogus",
        NUGET,
        "csharp",
        "data",
        "Generate realistic data with new Faker<T>().RuleFor(...); seed the "
        "Faker so a failing test reproduces.",
    ),
    TestLibrary(
        "verify-xunit",
        "Verify.Xunit",
        "Verify.Xunit",
        NUGET,
        "csharp",
        "snapshot",
        "Snapshot-test large results with await Verify(result) rather than "
        "asserting field by field.",
    ),
    TestLibrary(
        "aspnet-mvc-testing",
        "ASP.NET Core Test Host",
        "Microsoft.AspNetCore.Mvc.Testing",
        NUGET,
        "csharp",
        "http",
        "Test endpoints end to end through WebApplicationFactory<Program> and "
        "its HttpClient, not by calling the controller class directly.",
    ),
    TestLibrary(
        "wiremock-net",
        "WireMock.Net",
        "WireMock.Net",
        NUGET,
        "csharp",
        "http",
        "Stand up a stub HTTP server with WireMockServer.Start() instead of "
        "mocking HttpClient by hand.",
    ),
    TestLibrary(
        "testcontainers",
        "Testcontainers",
        "Testcontainers",
        NUGET,
        "csharp",
        "http",
        "Run the real dependency (database, broker) in a container from the "
        "test fixture rather than faking its client.",
    ),
    TestLibrary(
        "coverlet",
        "Coverlet",
        "coverlet.collector",
        NUGET,
        "csharp",
        "coverage",
        'Coverage collector for `dotnet test --collect:"XPlat Code Coverage"`; '
        "it changes nothing in the test code itself.",
    ),
    TestLibrary(
        "flaui",
        "FlaUI",
        "FlaUI.UIA3",
        NUGET,
        "csharp",
        "ui",
        "Drive the desktop UI through FlaUI's Application/Window automation, "
        "finding elements by AutomationId.",
    ),
    # ── Node ─────────────────────────────────────────────────────────
    TestLibrary(
        "vitest",
        "Vitest",
        "vitest",
        NPM,
        "typescript",
        "framework",
        "Use describe/it/expect imported from 'vitest', and vi.fn()/vi.mock() "
        "for doubles.",
        recommended=True,
    ),
    TestLibrary(
        "jest",
        "Jest",
        "jest",
        NPM,
        "typescript",
        "framework",
        "Use describe/it/expect from the global Jest environment and jest.fn()/"
        "jest.mock() for doubles.",
    ),
    TestLibrary(
        "testing-library-react",
        "Testing Library (React)",
        "@testing-library/react",
        NPM,
        "typescript",
        "ui",
        "Render with render() and query by accessible role or label — never by "
        "class name or test id when a role exists.",
    ),
    TestLibrary(
        "user-event",
        "user-event",
        "@testing-library/user-event",
        NPM,
        "typescript",
        "ui",
        "Drive interactions with userEvent.setup() rather than fireEvent, so "
        "the test goes through the same events a person would produce.",
    ),
    TestLibrary(
        "msw",
        "MSW",
        "msw",
        NPM,
        "typescript",
        "http",
        "Intercept HTTP at the network layer with setupServer(http.get(...)) "
        "instead of mocking fetch.",
    ),
    TestLibrary(
        "faker-js",
        "Faker",
        "@faker-js/faker",
        NPM,
        "typescript",
        "data",
        "Generate test data with faker.*; seed it so a failure reproduces.",
    ),
    TestLibrary(
        "playwright",
        "Playwright",
        "@playwright/test",
        NPM,
        "typescript",
        "framework",
        "For end-to-end specs: test/expect from '@playwright/test', locators by "
        "role, and web-first assertions (await expect(locator).toBeVisible()).",
    ),
    # ── Python ───────────────────────────────────────────────────────
    TestLibrary(
        "pytest",
        "pytest",
        "pytest",
        PYPI,
        "python",
        "framework",
        "Plain test functions with assert, fixtures for setup, and "
        "@pytest.mark.parametrize for cases — no unittest.TestCase.",
        recommended=True,
    ),
    TestLibrary(
        "pytest-mock",
        "pytest-mock",
        "pytest-mock",
        PYPI,
        "python",
        "mocking",
        "Use the `mocker` fixture (mocker.patch, mocker.Mock) rather than "
        "unittest.mock context managers.",
        recommended=True,
    ),
    TestLibrary(
        "hypothesis",
        "Hypothesis",
        "hypothesis",
        PYPI,
        "python",
        "data",
        "Add property-based tests with @given(st....) for the invariants that "
        "hold for every input, alongside the example-based ones.",
    ),
    TestLibrary(
        "freezegun",
        "freezegun",
        "freezegun",
        PYPI,
        "python",
        "data",
        "Pin time with @freeze_time(...) instead of monkeypatching datetime.",
    ),
    TestLibrary(
        "responses",
        "responses",
        "responses",
        PYPI,
        "python",
        "http",
        "Register HTTP stubs with @responses.activate rather than patching the "
        "requests module.",
    ),
    TestLibrary(
        "pytest-cov",
        "pytest-cov",
        "pytest-cov",
        PYPI,
        "python",
        "coverage",
        "Coverage plugin for `pytest --cov`; it changes nothing in the test "
        "code itself.",
    ),
    # ── Java ─────────────────────────────────────────────────────────
    TestLibrary(
        "junit5",
        "JUnit 5",
        "org.junit.jupiter:junit-jupiter",
        MAVEN,
        "java",
        "framework",
        "Use @Test, @ParameterizedTest and @BeforeEach from JUnit Jupiter.",
        recommended=True,
    ),
    TestLibrary(
        "mockito",
        "Mockito",
        "org.mockito:mockito-core",
        MAVEN,
        "java",
        "mocking",
        "Mock with mock(T.class), stub with when(...).thenReturn(...), verify "
        "with verify(...).",
        recommended=True,
    ),
    TestLibrary(
        "assertj",
        "AssertJ",
        "org.assertj:assertj-core",
        MAVEN,
        "java",
        "assertions",
        "Assert with assertThat(result).isEqualTo(...) and its fluent "
        "collection/exception matchers.",
        recommended=True,
    ),
)

_BY_ID = {library.id: library for library in CATALOGUE}

# Category display order — frameworks first, because everything else is written
# inside one.
CATEGORY_ORDER: tuple[str, ...] = (
    "framework",
    "assertions",
    "mocking",
    "data",
    "http",
    "ui",
    "snapshot",
    "coverage",
)

# A language shares its catalogue with the languages that share its ecosystem.
_LANGUAGE_ALIASES = {"javascript": "typescript", "kotlin": "java"}

_PACKAGE_REFERENCE = re.compile(
    r"""<(?:PackageReference|PackageVersion)\s[^>]*Include\s*=\s*["']([^"']+)["']""",
    re.I,
)
_PACKAGES_CONFIG = re.compile(r"""<package\s[^>]*id\s*=\s*["']([^"']+)["']""", re.I)


def catalogue_for(language: str) -> list[TestLibrary]:
    """Every library on offer for *language*, in display order."""
    target = _LANGUAGE_ALIASES.get(language, language)
    return sorted(
        (library for library in CATALOGUE if library.language == target),
        key=lambda library: (
            CATEGORY_ORDER.index(library.category)
            if library.category in CATEGORY_ORDER
            else len(CATEGORY_ORDER),
            library.name.lower(),
        ),
    )


def library_by_id(library_id: str) -> TestLibrary | None:
    return _BY_ID.get(library_id)


def parse_ids(raw: str | None) -> list[str]:
    """Read a comma-separated selection, dropping ids the catalogue lacks.

    An unknown id is dropped rather than passed through: the ids reach the
    prompt, and inventing a library for the model to write against is exactly
    the failure this module exists to prevent.
    """
    if not raw:
        return []
    seen: set[str] = set()
    ids: list[str] = []
    for chunk in raw.replace(";", ",").split(","):
        candidate = chunk.strip()
        if candidate in _BY_ID and candidate not in seen:
            seen.add(candidate)
            ids.append(candidate)
    return ids


# ── What the project already references ──────────────────────────────


def detect_installed(project_dir: str | Path, language: str) -> dict[str, str]:
    """Package ids the project declares, lowercased, mapped to their version.

    The version is "" when the manifest does not state one (a `packages.config`
    without it, a package.json range we keep verbatim) — callers use presence,
    not the value.
    """
    root = Path(project_dir)
    if not root.is_dir():
        return {}
    target = _LANGUAGE_ALIASES.get(language, language)
    if target == "csharp":
        return _detect_nuget(root)
    if target == "typescript":
        return _detect_npm(root)
    if target == "python":
        return _detect_pypi(root)
    if target == "java":
        return _detect_maven(root)
    return {}


def _detect_nuget(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    manifests = iter_project_files(
        root, ("*.csproj", "*.fsproj", "packages.config", "Directory.Packages.props")
    )
    for manifest in manifests:
        blob = read_manifest(manifest)
        for match in _PACKAGE_REFERENCE.finditer(blob):
            found.setdefault(match.group(1).lower(), _version_near(blob, match.end()))
        if manifest.name.lower() == "packages.config":
            for match in _PACKAGES_CONFIG.finditer(blob):
                found.setdefault(
                    match.group(1).lower(), _version_near(blob, match.end())
                )
    return found


def _version_near(blob: str, offset: int) -> str:
    """The Version="…" of the element that starts at *offset*, or ""."""
    tail = blob[offset : offset + 200]
    match = re.search(r"""[Vv]ersion\s*=\s*["']([^"']+)["']""", tail)
    return match.group(1) if match else ""


def _detect_npm(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for manifest in iter_project_files(root, ("package.json",)):
        try:
            data = json.loads(read_manifest(manifest) or "{}")
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        for key in ("dependencies", "devDependencies"):
            section = data.get(key)
            if isinstance(section, dict):
                for name, version in section.items():
                    found.setdefault(str(name).lower(), str(version) if version else "")
    return found


_REQUIREMENT = re.compile(r"^\s*([A-Za-z0-9._-]+)", re.M)


def _detect_pypi(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for manifest in iter_project_files(
        root, ("requirements*.txt", "pyproject.toml", "Pipfile")
    ):
        blob = read_manifest(manifest)
        for line in blob.splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            match = _REQUIREMENT.match(stripped)
            if match:
                found.setdefault(match.group(1).lower(), "")
    return found


def _detect_maven(root: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for manifest in iter_project_files(root, ("pom.xml", "build.gradle*")):
        blob = read_manifest(manifest).lower()
        for library in CATALOGUE:
            if library.ecosystem != MAVEN:
                continue
            artifact = library.package.split(":")[-1]
            if artifact.lower() in blob:
                found.setdefault(library.package.lower(), "")
    return found


def _is_installed(library: TestLibrary, installed: dict[str, str]) -> bool:
    if library.ecosystem == MAVEN:
        artifact = library.package.split(":")[-1].lower()
        return any(artifact in key for key in installed)
    return library.package.lower() in installed


# ── The answer the UI and the runner both use ────────────────────────


@dataclass
class LibrarySelection:
    """What the generated tests will be written against, and why."""

    language: str
    selected: list[TestLibrary]
    installed_ids: list[str]
    # True when the ids came from the user rather than from the project.
    explicit: bool

    __test__ = False

    def ids(self) -> list[str]:
        return [library.id for library in self.selected]

    def to_dict(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "selected": [library.id for library in self.selected],
            "installed": list(self.installed_ids),
            "explicit": self.explicit,
            "libraries": [
                {**library.to_dict(), "installed": library.id in self.installed_ids}
                for library in catalogue_for(self.language)
            ],
            "missing": [
                {
                    "id": library.id,
                    "name": library.name,
                    "package": library.package,
                    "ecosystem": library.ecosystem,
                }
                for library in missing_packages(self)
            ],
            "install_commands": install_commands(self),
        }


def resolve_selection(
    project_dir: str | Path,
    language: str,
    selected_ids: list[str] | None = None,
) -> LibrarySelection:
    """What to write the tests against: the user's choice, or the project's.

    With no explicit choice, the answer is what the project already references —
    the strongest possible signal, and one nobody had to type. A project that
    references nothing yet falls back to the language's recommended set, which
    is a suggestion the UI shows pre-checked, not a decision made behind
    anyone's back.
    """
    target = _LANGUAGE_ALIASES.get(language, language)
    installed = detect_installed(project_dir, target)
    catalogue = catalogue_for(target)
    installed_ids = [
        library.id for library in catalogue if _is_installed(library, installed)
    ]

    if selected_ids:
        chosen = [_BY_ID[i] for i in selected_ids if i in _BY_ID]
        return LibrarySelection(target, chosen, installed_ids, explicit=True)

    if installed_ids:
        chosen = [library for library in catalogue if library.id in installed_ids]
        return LibrarySelection(target, chosen, installed_ids, explicit=False)

    chosen = [library for library in catalogue if library.recommended]
    return LibrarySelection(target, chosen, installed_ids, explicit=False)


def missing_packages(selection: LibrarySelection) -> list[TestLibrary]:
    """Chosen libraries the project does not reference yet."""
    installed = set(selection.installed_ids)
    return [library for library in selection.selected if library.id not in installed]


def install_commands(selection: LibrarySelection) -> list[str]:
    """The commands that would add the missing packages, one per ecosystem."""
    missing = missing_packages(selection)
    if not missing:
        return []
    commands: list[str] = []
    by_ecosystem: dict[str, list[str]] = {}
    for library in missing:
        by_ecosystem.setdefault(library.ecosystem, []).append(library.package)
    for ecosystem, packages in by_ecosystem.items():
        if ecosystem == NUGET:
            commands.extend(
                f"dotnet add <test project> package {package}" for package in packages
            )
        elif ecosystem == NPM:
            commands.append(f"npm install --save-dev {' '.join(packages)}")
        elif ecosystem == PYPI:
            commands.append(f"pip install {' '.join(packages)}")
        elif ecosystem == MAVEN:
            commands.extend(f"add {package} to the test scope" for package in packages)
    return commands


# ── What the model is told ───────────────────────────────────────────


def render_prompt_section(selection: LibrarySelection) -> str:
    """The prompt fragment naming the libraries and how to write with them.

    Empty when nothing is selected: a heading with no entries under it reads to
    the model as a constraint it cannot satisfy.
    """
    if not selection.selected:
        return ""

    lines = [
        "",
        "Test libraries to use (the project's own stack — do not introduce others):",
    ]
    for library in selection.selected:
        lines.append(f"- {library.name} (`{library.package}`): {library.usage}")
    lines.append(
        "Write every import/using these require. Use ONLY these libraries: a test "
        "referencing a package the project does not have does not compile, and a "
        "reviewer cannot tell that from reading it."
    )
    return "\n".join(lines)
