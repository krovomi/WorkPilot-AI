# Spec by example: integration tests before code (ASP.NET Core)

Plan of 29 October, IA6. Goal mode ([goal-mode.md](goal-mode.md)) gives a card
a definition of done a program can run: `dotnet test` exits 0. Someone still
had to write the tests that command runs, and a coder that writes them after
the feature writes tests its own code already passes. On an ASP.NET Core Web
API, the `spec-by-example` phase writes the spec's acceptance criteria as
integration tests **before** any code, checks they fail, and makes them the
goal.

## When it runs

Declared in `feature-build` between `planning` and `coding`
(`workflows/feature-build/workflow.yaml`), run by
`apps/backend/workflows/spec_by_example_phase.py` (`CUSTOM_EXECUTORS` in
`workflows/runner.py`). After the plan is approved, so the tests follow the
plan the person accepted; before the coder, so they describe missing
behaviour.

It runs only when all of these hold, and says which one did not:

| Condition | Where |
|---|---|
| turned on: the task's `specByExample` in `task_metadata.json` wins both ways, else the project setting (Project settings > General), passed as `WORKPILOT_SPEC_BY_EXAMPLE` | `enabled` |
| the plan touches C# (`when: touches("**/*.cs,**/*.csproj")`, read against the plan's forecast) | the workflow engine |
| the project is an ASP.NET Core API (`project.stack.detect_api_stack`) | the phase |
| the task has **no goal** yet: a goal the person set is theirs, and this phase never replaces one | `goal.gate.read_goal` |

Never pruned by effort (`always: true`): the switch is the project's.

## What the session is told

One session on the coding phase's provider and model, agent `coder`, no
subagents. The prompt names `spec.md`, the plan, the test project (one that
references `Microsoft.AspNetCore.Mvc.Testing` first, else the first test
project, else one to create under `tests/`) and the test libraries the
solution already uses (`test_generation.libraries`). The rules: through HTTP
only (`WebApplicationFactory<Program>` and its `HttpClient`), no reference to
a type the feature has not created (the tests must compile today and fail on a
status or a body), nothing changed outside the test project and the solution
file, never a test weakened.

## What Python checks, in order

The session's word is not taken. After it:

| # | Check | If it fails | Why before the next |
|---|---|---|---|
| 1 | every file written (new, or changed since the session began, by content hash) is inside a test project, or is a solution file at the root | `✗`, no goal; the files stay for review | a test-first phase that edits the API has started the feature with nobody watching |
| 2 | at least one file was written | `✗`, no goal | nothing to run |
| 3 | one command covers them: `dotnet test "<project>"` for one project, `dotnet test "<solution>"` for several | could not run, no goal | the goal is one command |
| 4 | the tests compile (`error CS…`, `error MSB…`, `Build FAILED` in the output) | `✗`, no goal | a build error is not a red test, and a goal that cannot build is met by nothing |
| 5 | the run is **red** | green: could not run, no goal | tests that pass before any code describe nothing missing |

The run is `goal.check.run_goal`: no shell, its own process group, the
backend's environment without credentials. Nothing is reverted, ever: what the
session wrote stays in the worktree and reaches the diff a person reviews.

## The goal it sets

Only after a red run, in the main spec directory first and in the worktree's
copy, written then renamed, as the card writes it:

```json
{
  "command": "dotnet test \"tests/Api.Tests/Api.Tests.csproj\"",
  "expectedExit": 0,
  "timeoutSeconds": 900,
  "protected": ["tests/Api.Tests/OrdersEndpointTests.cs"],
  "origin": "spec-by-example"
}
```

`protected` is the files written (the `.csproj` aside, so the coder can still
add a reference), or the test projects' `**/*.cs` past the goal's cap of 64.
From then on it is an ordinary goal: the card shows it, the person can edit or
remove it, the QA loop goes on until `dotnet test` exits 0, and a change to a
protected test is sent back to the fixer. `origin` is read by nobody; it says
in the file who wrote it.

## Limits

- ASP.NET Core only. The same phase for FastAPI, Express or Spring is a
  different prompt and a different command; `docintel/api_tests.py` already
  knows those idioms.
- `feature-build` only. A bug fix would gain a reproducing test first too, and
  is the natural next step.
- The phase does not judge whether the tests cover the spec: the coverage gate
  and the QA reviewer do, as for any test.

## Tests

`tests/test_spec_by_example.py`: the switch and its precedence; test projects
found and ordered; files written classified (re-edited dirty file, root
solution, sub-folder solution); the command for one or several projects; the
red / green / broken / error readings; the goal as the gate reads it; the
phase end to end with a real git repository, a scripted session and a
scripted `dotnet test` (off, not ASP.NET Core, a goal the person set, red,
code outside the tests, no compile, green, nothing written, no `dotnet`, a
session that cannot open).
