# Test generation

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Where generated tests are written

The test generator asks the model for a file *path*, and what comes back is a
convention it remembers — `CalculatorTests.cs`, `tests/test_calculator.py` —
which used to be resolved against the project root because there was nowhere
else to resolve it. On a .NET solution whose sources live under `src/`, that put
the unit tests at the top of the repository, beside the `.sln`.

`test_generation/layout.py` is the single answer to "where does this file go?",
and every writer goes through it: the runner (`--action generate-unit`), the
post-build service, and the pre-flight the Kanban runs before a generation. It
reads paths only — no model, no network — so the UI can ask the question before
the run starts and pay nothing for it.

| Situation | Answer |
|---|---|
| a `tests` directory beside the source root (`src`, `source`, `sources`) | that one |
| a test file for this source already exists | its directory — the project decided |
| a `__tests__` the project already uses, or a .NET `*.Tests` project | that one |
| Go and Rust | next to the source; a `_test.go` elsewhere is a compile error, not a test suite |
| **none of the above** | **`needs_choice`** — the UI asks |

The last row is the point. A guess there is how the file ends up next to the
solution file, so the resolution stops and `TestDestinationDialog` offers the
candidates the project's layout suggests, plus a path the user types (created on
write). A caller with nobody to ask — the CLI, the post-build hook — takes the
first candidate and says so; the first candidate is a `tests` directory, never
the project root, so the bad answer is no longer reachable.

The model's **file name** is kept: it carries the extension and the framework's
naming convention, and `sanitize_file_name` strips everything else, so a
generated path cannot escape the chosen directory. E2E generation keeps its own
`e2e/` convention — it covers a scenario, not a source file, so "beside the
source root" answers a question it is not asking.

## What generated tests are written against

The same question, one step earlier: a test file is only useful if it is written
in the idiom the project tests in. Asked for a C# test with no further
instruction, a model reaches for bare `Assert.Equal` — so a solution
standardised on FluentAssertions and Moq got tests it had to rewrite by hand,
and one with no test project at all got tests that do not compile.

`test_generation/libraries.py` answers it from two facts, neither of which needs
a model:

| Input | Where it comes from |
|---|---|
| what the project **already references** | `.csproj`, `packages.config`, `Directory.Packages.props`, `package.json`, `requirements*.txt`, `pyproject.toml`, `pom.xml` |
| what the user **chose** | the picker, remembered per project, sent as `--test-libraries` |

With no explicit choice, the project's own packages are the answer — the
strongest signal available, and one nobody had to type. Only a project that
references nothing falls back to the language's recommended set, shown
pre-ticked rather than applied silently. The selection becomes a prompt section
naming each library **and how to write with it** (`result.Should().Be(...)`,
`new Mock<T>()`, `Substitute.For<T>()`), because "FluentAssertions exists"
changes nothing about the generated file and the idiom changes all of it.

The catalogue is curated — xUnit, NUnit, MSTest, FluentAssertions, Shouldly,
Moq, NSubstitute, FakeItEasy, AutoFixture, Bogus, Verify, WireMock.Net,
Testcontainers, Coverlet, FlaUI, and the npm / PyPI / Maven equivalents. A list
of every test package on nuget.org is a search box, and a search box is what the
picker exists to avoid.

**Installing is a separate action.** `libraries.py` runs no package manager;
`package_install.py` does, and only from the runner's `add-packages` action,
which the UI calls from a button the user presses after seeing exactly which
packages are missing. A generation that quietly ran `dotnet add package` would
edit a `.csproj` nobody asked it to edit. NuGet goes through `dotnet add
package` (one package per command, so a half-finished batch is still reportable)
and npm through the project's own package manager, read from its lockfile; pip
and Maven are *reported as commands*, never run — a pip install lands in
whichever environment happens to be active, and that is not a guess to make on
someone's behalf.
