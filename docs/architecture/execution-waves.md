---
feature: Execution waves (Conflict Predictor)
summary: >-
  Groupe les specs en attente en vagues sans fichier commun (plan ∪ changements du worktree, toutes
  langues, zéro LLM), ordre de merge, cycles signalés ; « Exécuter dans l'ordre optimal » lance
  vague après vague par le chemin de démarrage habituel, replanifie à chaque vague.
---

# Execution waves (Conflict Predictor)

Issue #358 (lot 1). The Conflict Predictor already scored pairs of live worktrees
(`apps/backend/services/conflict_predictor_service.py`) and the swarm groups the subtasks of
**one** spec into waves (`apps/backend/agents/swarm/dependency_analyzer.py`). This feature
plans **across specs**: which of the specs waiting in the backlog or the queue may run side by
side, in which order, and runs them that way.

Shown in Mission Control (a "Execution waves" section, with or without a Mission Control session).

## Code

| Part | File |
|---|---|
| Scorer (file weight, pair score) | `apps/frontend/src/main/conflict-waves/scorer.ts` |
| Planner (graph, cycles, colouring, merge order) | `apps/frontend/src/main/conflict-waves/planner.ts` |
| Worktree changes (git by argument list) | `apps/frontend/src/main/conflict-waves/worktree-files.ts` |
| Request validation, project resolution | `apps/frontend/src/main/conflict-waves/plan-service.ts` |
| IPC `conflictWaves:plan` | `apps/frontend/src/main/ipc-handlers/conflict-waves-handlers.ts`, `preload/api/modules/conflict-waves-api.ts` |
| Run, wave after wave | `apps/frontend/src/renderer/lib/wave-execution.ts`, `stores/execution-waves-store.ts` |
| View | `apps/frontend/src/renderer/components/conflict-predictor/WavesView.tsx` |
| Types | `apps/frontend/src/shared/types/conflict-waves.ts` |

## Why in the main process, in TypeScript

The inputs are already there: `projectStore.getTasks()` reads every spec's
`implementation_plan.json` and gives each subtask its files (`extractSubtaskFiles`: the real
`files_changed` once a subtask is done, the planner's `files_to_modify` / `files_to_create`
before). The plan-time overlap check of one task (`main/utils/plan-conflicts.ts`) lives there
too, and the queue that starts tasks is in the renderer. A Python runner would have re-read the
same files for a computation that takes milliseconds. The planner is pure (no I/O, no clock),
so moving it behind a backend route for server mode later is a copy, not a rewrite.

## Score

Static, deterministic, no model whatever the provider. A spec's footprint is the files its plan
declares ∪ the files its worktree has changed (commits, index, working tree, untracked; WorkPilot's
own files and build output left out). Paths compare without case, `\` or `./`.

A shared file weighs by its role in the build, never by its language:

| Weight | Files |
|---|---|
| 3 | dependency manifests and lockfiles: npm/pnpm/yarn/bun/deno, pyproject/poetry/uv/requirements, go.mod/sum, Cargo, Maven/Gradle, `.csproj`/`.fsproj`/`.sln`/`Directory.*.props`, Gemfile, Composer, pubspec, SwiftPM, CocoaPods, Mix, CMake, vcpkg, sbt, Cabal/Stack… |
| 2 | shared configuration: `.env*`, `*.config.*`, `tsconfig*`, Dockerfile, compose, Makefile, CI pipelines, `appsettings*.json`, YAML/TOML/INI |
| 1 | every other file |

A pair's score is the sum; level `low` < 2 ≤ `medium` < 4 ≤ `high` < 8 ≤ `critical`.

## Plan

1. **Conflict graph**: an edge when the score is above the **tolerance** (default 0: one shared
   file is enough). The tolerance answers the over-estimation case of the issue (two specs editing
   the same file in disjoint places).
2. **Unplanned spec** (no plan, no worktree): its footprint is unknown. Default `isolate`: it
   never shares a wave; option `independent` assumes it touches nothing the others touch.
   Unplanned specs come after the planned ones, so a plan written meanwhile (a task with "review
   before coding") is picked up by the next re-plan.
3. **Dependencies** (`metadata.blockedBy`, the same field the queue honours) are precedence
   constraints. A cycle (Tarjan) cannot be planned without a person: its specs and those waiting
   on them are excluded and named in a red notice.
4. **Greedy colouring**: by dependency depth, planned first, then weighted conflict degree (most
   constrained first), priority, age, id. Each spec goes in the feasible wave (later than its
   blockers, no edge with a member, under the project's **max parallel tasks**) that adds the
   least residual (sub-tolerance) risk, the earliest on a tie.
5. **Merge order** inside a wave: the spec that shares most with later waves first; the waves
   after it then start from a base that holds it.

The result gives the total risk (everything at once) and the residual risk (inside the waves):
their difference is the risk the plan avoids.

Durations are never estimated (project rule): the "Gantt" lays specs out by wave, the waves run
one after the other.

## Dynamic re-planning

- **Drift**: a spec whose worktree changed files outside its plan (≥ 3 by default) is reported
  ("touched 5 files outside its plan. Replan?"), running specs included. Replan recomputes from
  the worktrees as they are.
- **At each wave**: when a wave settles, the specs not started yet are planned again, with the
  real changes of the specs that ran.
- A queued spec that shares files with a spec already running is reported.

## Execute in optimal order

The run starts the tasks of the current wave with `persistTaskStatus(id, "in_progress")`, the path
the board's queue uses: the main process checks git and the provider's authentication and starts
the build with the task's own provider and model. No new way to launch an agent. The run never
starts more than the project's max parallel tasks (tasks running outside the plan count), never
starts a task whose dependency is not finished, and never starts one twice. Waiting tasks stay in
the backlog, so the board's queue cannot promote them out of order.

The next wave starts once every task of the wave is **merged** (`done`, default: the next wave
branches from a base that holds it) or, as an option, **in review** (`human_review`,
`pr_created`, `done`, `error`, `build_failed`). A task put back in the backlog after it was
started, archived or abandoned no longer holds the wave.

The run watches the task store for the window's lifetime (`global-listeners.ts`), so it goes on
when the person leaves the page. It is in memory: closing the app ends the run, never the tasks
already started. Stop ends the run; running tasks keep going.

## Boundary

`conflictWaves:plan` takes `{ projectId, taskIds?, options? }`. The handler checks every field:
project id shape, at most 200 task ids, each one a spec folder name (letters, digits, marks,
`.` `_` `-`, no separator), each one a backlog or queued task of **that** project; tolerance and
drift threshold bounded numbers, policy in a closed list. The max parallelism is read from the
project's settings, never from the request. Worktrees are found with `findTaskWorktree`
(resolved, kept inside the project) and read with `git` by argument list, with a timeout and a
cap of 2 000 files. Refusals are tested (`plan-service.test.ts`, `conflict-waves-handlers.test.ts`).

## Not in lot 1

- Symbols and cross imports in the score (renamed symbols, a spec importing what another edits),
  "fragile zones" from the history; a "preventive merge to check" for sub-tolerance pairs.
- Server mode: a backend route over the same planner for server projects and the mobile app.
- A persistent run (resumed after a restart) and the sprint metrics of the issue (conflicts
  avoided, resolution time of residual conflicts).
