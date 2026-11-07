# .NET 11 and C# 15 (migrate-dotnet10-to-dotnet11)

> Rationale for the `dotnet_upgrade` package and the `migrate-dotnet10-to-dotnet11` skill.
> [`docs/CLAUDE.md`](../CLAUDE.md) stays the normative file: where the two disagree, it wins.

## What it is

The .NET team publishes a `migrate-dotnet10-to-dotnet11` skill in
[dotnet/skills](https://github.com/dotnet/skills) (MIT). It is a procedure (assess,
retarget, fix the build, review behavioral changes, infrastructure, verify) plus one
reference file per area. WorkPilot carries an **adapted copy** in
`skills/dotnet/migrate-dotnet10-to-dotnet11/`, with the upstream commit in its
frontmatter and the license beside it.

**Why adapted, not vendored as is.** Audited on 2026-11-07 against the official lists:

- no script, no command beyond `dotnet` and file edits, no URL outside
  learn.microsoft.com and github.com — nothing unsafe;
- but frozen at Preview 3 while .NET 11 was at RC2: about sixty documented breaking
  changes were missing (`closed` and `union` keywords, the whole Extensions area, 18 of
  the 20 ASP.NET Core 11 entries, most of EF Core 11, MAUI's switch to CoreCLR, the SDK
  and NuGet changes);
- one piece of advice was wrong: it said `BackgroundService` exceptions used to be
  swallowed and told the agent to wrap `ExecuteAsync` in a catch-all. The default has
  stopped the host since .NET 6; what .NET 11 changes is the exit code. A catch-all turns a
  crashed worker into a silently idle one;
- `dotnet --version` as the SDK check reports what `global.json` selects, not what is
  installed: an agent on a pinned 10.x saw "no .NET 11" with the SDK present;
- the reference table was printed twice, and the procedure restated the references.

The adapted `SKILL.md` is a triage index (symptom → reference, search pattern →
reference) so an agent loads two or three of the ten files, not all of them. A
`csharp15-adoption.md` reference covers *using* C# 15 (unions, `closed` hierarchies,
collection-expression arguments, extension indexers, labeled `break`/`continue`) after
the migration. The references are a dated snapshot; the procedure names the official
list as the authority for anything newer, as data and never as instructions.

## Where it reaches a task

| Where | What | When |
|---|---|---|
| `.agents/skills/` (and every harness mirror) | the skill, emitted by `skills-cli build` | always in this repository (`dotnet` pack, `targets: dotnet >=10.0 <12.0`) |
| Kanban palette | `/migrate-dotnet10-to-dotnet11`, as a bundled command | only for a project on .NET 10 or 11 (`slash_commands.api._bundled_applies`) |
| `dotnet_upgrade.preflight` (before planning) | the skill copied to `<spec_dir>/dotnet11/`, plus `result.json` | see below |
| `dotnet_upgrade.prompt` | a short section: the staged procedure and the references this project needs | planner, every coding subtask, QA reviewer, workflow skill phases |

The preflight decides, from the worktree and the task's words:

| Project | Task | Mode |
|---|---|---|
| .NET 10 | names .NET 11 or C# 15 | `migrate` |
| .NET 5–9 | names .NET 11 or C# 15 | `chain`: the releases in between first, with their official lists |
| .NET 11 | anything | `adopt`: C# 15 and the breaking-change notes at hand |
| .NET Framework, `netstandard` only, no .NET, .NET 10 task about something else | — | `skipped`: the section is empty, nothing is copied |

**Why a copy next to the spec.** The bundled skill lives outside the project. A Claude
session could read it there; the providers that go through `core.runtimes.tool_executor`
(OpenAI and compatibles, Gemini, Ollama…) refuse any path outside the project directory.
`<spec_dir>` is inside the project and git-ignored (`.workpilot/`), so the copy is
readable by every provider and never lands in the diff — the same reason libdocs and
docintel stage their material there.

**Why a pointer, not the text.** The procedure is about 9 KB and the references 40 KB.
The section names the procedure and the two to five references the project files select
(the four general ones, then ASP.NET Core, EF Core, cryptography, runtime/AOT, MAUI from
the SDK attribute and package references); the procedure's Step 1 adds what only the code
reveals. The section reads one JSON file, so it is identical for every subtask and
caches.

## Detection fixes that came with it (F158)

`skills_registry.project` read the TargetFramework from `*.csproj` only and with a
pattern that missed platform monikers: a WPF, WinUI or MAUI project on `net10.0-windows`
or `net11.0-android` had no .NET version, so no `dotnet` skill applied to it, and
`netstandard2.0` was read as ".NET 2.0". It now reads `*.csproj`, `*.fsproj`, `*.vbproj`
and `Directory.Build.props`, takes a platform TFM by its runtime, ignores `netstandard`,
and skips `bin/` and `obj/`.

## Updating the snapshot

When .NET 11 ships or a servicing release adds breaking changes: compare each reference
with its official page (the URLs are in each file), keep the Step 3 and Step 4 tables in
`SKILL.md` in step, rebuild (`pnpm run skills:build`). `tests/test_dotnet_upgrade.py`
fails when the procedure names a reference that does not exist. For .NET 12, add a new
skill beside this one rather than rewriting it: projects still on 10 keep needing it.
