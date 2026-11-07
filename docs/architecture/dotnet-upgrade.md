# .NET migrations 8 → 9 → 10 → 11 and C# 15

> Rationale for the `dotnet_upgrade` package and the `migrate-dotnet8-to-dotnet9`,
> `migrate-dotnet9-to-dotnet10` and `migrate-dotnet10-to-dotnet11` skills.
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

## The earlier hops (8 → 9, 9 → 10)

dotnet/skills publishes one skill per release; WorkPilot carries the two before 10 → 11,
adapted the same way (same upstream commit, same license, same triage-index shape), so a
project on .NET 8 or 9 is migrated one release at a time. Audited on 2026-11-07 against
the official lists (`core/compatibility/9` and `/10`, EF Core 9 and 10, ASP.NET Core 9 and
10, the Roslyn breaking-change files):

- nothing unsafe: no script, `dotnet` commands and file edits only, links to
  learn.microsoft.com and github.com; the mitigations that silence a check (EF Core
  pending-model warnings, BinaryFormatter compatibility package) are already labelled
  temporary or refused;
- written after GA, so far more complete than the 10 → 11 one was, but missing what the
  lists gained since: six C# 14 compiler changes (record pointer members, partial
  interface members now `public virtual`, `EmbeddedAttribute` validation…), `DefineConstants`
  no longer usable in project-file conditions, insecure HTTP NuGet and audit sources as
  errors, the SqlClient broker dependency, five EF Core 9 entries (all migrations in one
  transaction — reverted in EF Core 10 —, primitive-collection APIs, `IndexOf` nulls,
  `EF.Constant` in compiled queries, JSON identity resolution), and the named-mutex scope
  change that servicing releases 8.0.32, 9.0.21 and 10.0.13 brought;
- the same `dotnet --version` check and duplicated reference tables as 10 → 11;
- no word on support: .NET 8 (LTS) and .NET 9 (STS) both end on 10 November 2026. The
  adapted procedures say so, and treat 8 → 9 as a first hop towards .NET 10 (LTS to
  November 2028) unless the task says otherwise.

Reference files share one vocabulary of areas across the three skills (`aspnetcore`,
`extensions`… renamed from upstream's `aspnet-core`, `extensions-hosting`), so the
detection names an area once and each hop keeps the files it has.

## Where it reaches a task

| Where | What | When |
|---|---|---|
| `.agents/skills/` (and every harness mirror) | the skills, emitted by `skills-cli build` | always in this repository (`dotnet` pack; targets `>=8.0 <10.0`, `>=9.0 <11.0`, `>=10.0 <12.0`) |
| Kanban palette | each skill as a bundled command | only for a project on its source or target release (`slash_commands.api._bundled_applies`) |
| `dotnet_upgrade.preflight` (before planning) | each hop's skill copied to `<spec_dir>/dotnet-upgrade/<skill>/`, plus `result.json` | see below |
| `dotnet_upgrade.prompt` | a short section: the staged procedures in order and the references this project needs from each | planner, every coding subtask, QA reviewer, workflow skill phases |

The preflight decides, from the worktree and the task's words. The target is the newest
release the task names (".NET 10", "net11.0", "C# 14"…; "de .NET 9 vers .NET 10" → 10):

| Project | Task names | Mode | Staged |
|---|---|---|---|
| .NET 8, 9 or 10 | the next release | `migrate` | that hop |
| .NET 8 or 9 | a release two or three ahead | `chain` | every hop, in order |
| .NET 5–7 | .NET 9, 10 or 11 | `chain` | the hops from 8, after the official lists up to 8 |
| .NET 11 | anything | `adopt` | 10 → 11, for C# 15 and its notes |
| .NET Framework, `netstandard` only, no .NET, or no newer release named | — | `skipped` | nothing: the section is empty |

A project on .NET 8 or 9 whose task names no release is not migrated behind its back,
end of support or not: that is the person's call.

**Why a copy next to the spec.** The bundled skills live outside the project. A Claude
session could read it there; the providers that go through `core.runtimes.tool_executor`
(OpenAI and compatibles, Gemini, Ollama…) refuse any path outside the project directory.
`<spec_dir>` is inside the project and git-ignored (`.workpilot/`), so the copy is
readable by every provider and never lands in the diff — the same reason libdocs and
docintel stage their material there.

**Why a pointer, not the text.** A procedure is about 9 KB and its references 40 KB.
The section names each procedure and the references the project files select (the
general ones each hop has, then ASP.NET Core, EF Core, cryptography, runtime/AOT, MAUI,
WinForms/WPF, containers from the SDK attribute, package references and a Dockerfile);
each procedure's Step 1 adds what only the code reveals. The section reads one JSON file, so it is identical for every subtask and
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
fails when a procedure names a reference that does not exist. For .NET 12, add a
`migrate-dotnet11-to-dotnet12` skill beside these, register it in
`dotnet_upgrade.preflight.HOPS` and in the bundle (`skills_registry.bundled`,
`apps/frontend/package.json`), and teach `detect.requested_target` the new release:
projects still on 10 keep needing the older hops.
