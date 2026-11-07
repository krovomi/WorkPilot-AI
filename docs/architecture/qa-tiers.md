# QA tiers: light, targeted, full

Every QA reviewer pass first reads the task's change set from git
([`foundation/change_scope.py`](../../apps/backend/foundation/change_scope.py)): committed,
uncommitted and untracked files since the base branch, with their changed lines. The answer
picks one of three tiers, from git and file names only, so the same change gets the same tier
on every provider and model. The loop logs it before the session (`QA scope: light | targeted
— QA ciblée | full (reason)`), and the rendered `qa_report.md` carries a `Scope:` line.

| Tier | When | The reviewer | Subagents | Coverage gate |
|---|---|---|---|---|
| **light** (QA légère, F133) | only text/documentation files (≤ 10 files, ≤ 400 lines), or no change at all | spec + diff inline, checks the change against the spec; no test, no environment, no scan | none | not applicable |
| **targeted** (QA ciblée, K2) | ≤ 3 code files and ≤ 150 changed lines in them (text files aside), each with a mapped test | spec + diff + the exact test files inline; runs only those, with coverage of the touched files; security check on the changed files | none | `qa/targeted_gate.py` |
| **full** | anything else, and every doubt | `qa_reviewer.md`: environment, every suite with coverage, browser, database, scans of the changed files | the roster | `qa/coverage_gate.py` (unit + integration) |

The tier is read again on every pass: a fixer that grows a targeted change past a threshold,
or touches a security file, turns the next pass into a full one.

## Why a targeted tier

A one-line fix in a Python module with its test paid for the whole QA: dev environment, every
suite with coverage, subagents, project memory. The coverage gate asked for unit **and**
integration coverage of the repository, so the reviewer had to run everything to produce two
numbers that measure the repository, not the change. Small code changes are the bulk of the
board's cards; the light tier (text only) did not reach them.

## Selection

`classify()` keeps the full review for any doubt. A change is targeted only when all hold:

- `WORKPILOT_QA_LIGHT` and `WORKPILOT_QA_TARGETED` are not `0`;
- at most `TARGETED_MAX_CODE_FILES` (3) code files, at most `TARGETED_MAX_CHANGED_LINES` (150)
  lines changed in them, measured with `git diff --numstat` like the light tier (an untracked
  file counts all its lines);
- every code file is in a language whose test convention is known (see "Test mapping":
  Python, TypeScript/JavaScript and their frameworks, .NET and Blazor, Java/Kotlin/Scala/Groovy,
  Go, Rust, PHP, Swift, Dart/Flutter, Ruby, Elixir, C/C++): any other type a program reads
  (JSON, YAML, TOML, XML, `.csproj`, `pom.xml`, `build.gradle.kts`, lockfiles, `package.json`,
  `requirements*.txt`) is full;
- no code file is security-sensitive (a `security/` directory, `server/auth*`), CI
  (`.github/`, `.gitlab/`, `.circleci/`), generated (`dist/`, `build/`, `vendor/`,
  `node_modules/`, `generated/`, `.agents/`, `*.d.ts`, `*.min.js`, `*_pb2.py`, `*.generated.*`,
  `*.Designer.cs`, `*.g.cs`, `*.pb.go`, `*_gen.go`, `*.g.dart`, `*.freezed.dart`, `*.pb.swift`…,
  or a header saying `@generated`, `DO NOT EDIT`, `auto-generated`), project-wide (`conftest.py`,
  `setup.py`, `Program.cs`, `Startup.cs`, `GlobalUsings.cs`, `_Imports.razor`, `build.rs`,
  `Package.swift`, `mix.exs`, `spec_helper.rb`, `*.config.*`, dot-files) or deleted/renamed (a
  deleted test included);
- no touched file nor mapped test has a character a shell would interpret (space, `;`, `$`,
  quotes): the prompt hands those paths to the reviewer as command arguments, and a file name
  from the target repository is data (security rule S2);
- every code file has at least one test by convention. One without is full: the tier never
  skips testing a file.

`requirements*.txt` and `constraints*.txt` stopped being "text only" with this change: pip
reads them, so they never get the light review either.

## Test mapping

[`foundation/touched_tests.py`](../../apps/backend/foundation/touched_tests.py) looks the tests
up in the repository's file list (`git ls-files` plus untracked files), never by running
anything:

- Python: `test_<stem>.py` or `<stem>_test.py` next to the source, or under a `tests/` or
  `test/` directory at the source's level or above (at any depth below it:
  `tests/unit/core/test_engine.py` maps `src/core/engine.py`). `conftest.py` is not a test.
- TypeScript/JavaScript: `<stem>.test.<ext>` or `<stem>.spec.<ext>` next to the source, or
  under `__tests__/`, `tests/` or `test/` at the source's level or above; inside `__tests__/`,
  `<stem>.<ext>` counts too.
- Single-file components (`.vue`, `.svelte`, `.astro`) map like TypeScript (`Card.vue` →
  `Card.spec.ts`), and so do an Angular component's template and styles
  (`menu.component.html` / `.scss` → `menu.component.spec.ts`); Next.js and Nuxt pages are
  plain `.tsx`/`.vue`.
- The other ecosystems are in
  [`foundation/test_conventions.py`](../../apps/backend/foundation/test_conventions.py), each
  with the convention its own templates create:
  - .NET (C#, F#, VB, Blazor `.razor` and code-behind `X.razor.cs` / `X.xaml.cs`):
    `<Stem>Tests` or `<Stem>Test` (bUnit `.razor` tests too), e.g. `src/Shop/Cart.cs` →
    `tests/Shop.Tests/CartTests.cs`;
  - JVM (Java, Kotlin, Scala, Groovy): `<Stem>Test`, `Tests`, `IT` (Failsafe), `Spec`
    (Kotest, Spock), under Maven/Gradle `src/test`, Android `androidTest`, KMP `commonTest`;
  - Go: `<stem>_test.go` in the source's own directory, nowhere else;
  - Rust: `tests/<stem>.rs` of the crate, `<stem>/tests.rs`, `<stem>_test(s).rs`, or the
    source itself when it holds a `#[cfg(test)]` module (`change_scope` reads the file);
  - PHP (PHPUnit, Pest): `<Stem>Test.php`; Swift: `<Stem>Tests.swift` in a `*Tests` target;
    Dart/Flutter: `<stem>_test.dart` under `test/` or `integration_test/`; Ruby:
    `<stem>_spec.rb`, `<stem>_test.rb`, `test_<stem>.rb`; Elixir: `<stem>_test.exs`; C/C++:
    `<stem>_test`, `<stem>_unittest`, `test_<stem>`.

  Outside the same directory, a test counts under a test directory at the source's level or
  above: `tests`, `test`, `spec`, `__tests__`, `integration_test`, a `*.Tests` .NET project or
  a PascalCase/camelCase `…Test(s)` directory (`KitTests`, `androidTest`), never `latest/`.
  A file of a test project whose name is not a test (a builder, a fixture) is not one.
- A changed test maps to itself.

A name shared by several modules can map to more than one test: more tests run, never fewer.

## What the targeted pass must show

The prompt ([`prompts/qa_reviewer_targeted.md`](../../apps/backend/prompts/qa_reviewer_targeted.md))
inlines the spec, the diff and the map `source → tests`, and asks the reviewer to run each test
file by path with the project's runner and coverage of the touched files. Its approval stands
only if [`qa/targeted_gate.py`](../../apps/backend/qa/targeted_gate.py) finds, deterministically:

1. each mapped test in `qa_signoff.targeted_tests` with `passed: true`;
2. each mapped test named in a shell command the reviewer ran in this session: by its path or
   file name, or, for the ecosystems whose runner selects by class, package or target (.NET,
   JVM, Go, Rust, Swift, PHP, Dart, Ruby, Elixir, C/C++), by its stem as a whole word
   (`dotnet test --filter FullyQualifiedName~CartTests`, `mvn -Dtest=OrderTest`,
   `gradle --tests '*OrderTest'`, `cargo test --test parser`, `swift test --filter`) or by its
   directory or an enclosing test directory (`go test ./internal/auth`,
   `dotnet test tests/Shop.Tests`). Python and TypeScript tests keep the path-or-name rule.
   `qa/reviewer.py` collects the `command` (or `cmd`) of every tool call on both stream paths
   (Claude SDK and `AgentClient`), so the evidence does not depend on the provider;
3. `qa_signoff.coverage.touched_files` (and every `per_file` value of a touched file) at least
   `WORKPILOT_QA_MIN_COVERAGE`; `measured: false` or no value rejects. With the threshold at
   `0`, the tests are still required.

Otherwise the sign-off is set to `rejected`, `QA_FIX_REQUEST.md` lists the gaps and the fixer
runs, within the task's QA budget. An error inside the gate rejects too, unlike the coverage
gate's: the tier never approves a task whose tests it did not see run.

**Coverage is that of the touched files, not of the diff lines.** Diff coverage needs a tool
(diff-cover and the like) that most target projects do not have, while every coverage runner
reports per file (`pytest --cov`, `vitest --coverage.include`, `jest --collectCoverageFrom`,
coverlet, JaCoCo/Kover, `go test -cover`, `cargo llvm-cov`, PHPUnit, `swift test
--enable-code-coverage`, `flutter test --coverage`, SimpleCov, `mix test --cover`, gcovr). The
prompt only lists the run-and-coverage commands of the ecosystems present in the change.
At the default threshold (100 %) a touched file fully covered implies covered changed lines;
below it, the changed lines may be among the uncovered ones, which the report does not tell.

## Limits

- The evidence is the commands the reviewer ran and what it recorded, not a run by the loop
  itself: the target project's runner, environment and working directory are only known to
  the session. The command check stops a sign-off that claims tests no command named.
- A language or a layout outside these conventions (a test named after a feature rather than
  its source, Go tests in another package directory, a C++ project's custom test layout) gets
  the full review: the tier only trusts names it can map.
