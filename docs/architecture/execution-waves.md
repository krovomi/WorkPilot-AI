---
feature: Execution waves (Conflict Predictor)
summary: >-
  Groupe les specs en attente en vagues sans fichier commun (plan ∪ changements du worktree, zones
  fragiles de l'historique git, toutes langues, zéro LLM), merge de test des paires sous la
  tolérance, ordre de merge, cycles signalés ; « Exécuter dans l'ordre optimal » lance vague après
  vague par le chemin de démarrage habituel, replanifie à chaque vague, survit à un redémarrage.
---

# Execution waves (Conflict Predictor)

Issue #358 (lots 1 and 2). The Conflict Predictor already scored pairs of live worktrees
(`apps/backend/services/conflict_predictor_service.py`) and the swarm groups the subtasks of
**one** spec into waves (`apps/backend/agents/swarm/dependency_analyzer.py`). This feature
plans **across specs**: which of the specs waiting in the backlog or the queue may run side by
side, in which order, and runs them that way.

Shown in Mission Control (a "Execution waves" section, with or without a Mission Control session).

## Code

| Part | File |
|---|---|
| Scorer (file weight, pair score, fragile links) | `apps/frontend/src/main/conflict-waves/scorer.ts` |
| Planner (graph, cycles, colouring, merge order) | `apps/frontend/src/main/conflict-waves/planner.ts` |
| Worktree changes (git by argument list) | `apps/frontend/src/main/conflict-waves/worktree-files.ts` |
| Preventive merge check (`git merge-tree`) | `apps/frontend/src/main/conflict-waves/merge-check.ts` |
| Fragile zones (`git log`, co-changes) | `apps/frontend/src/main/conflict-waves/fragile-zones.ts` |
| Request validation, project resolution | `apps/frontend/src/main/conflict-waves/plan-service.ts` |
| Saved run (`.workpilot/execution-waves-run.json`) | `apps/frontend/src/main/conflict-waves/run-store.ts` |
| IPC `conflictWaves:plan`, `:loadRun`, `:saveRun`, `:clearRun` | `apps/frontend/src/main/ipc-handlers/conflict-waves-handlers.ts`, `preload/api/modules/conflict-waves-api.ts` |
| Run, wave after wave, saved at every step | `apps/frontend/src/renderer/lib/wave-execution.ts`, `stores/execution-waves-store.ts` |
| View | `apps/frontend/src/renderer/components/conflict-predictor/WavesView.tsx`, `WavesNotices.tsx` |
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

A pair's score is the sum, plus its fragile zones (below); level `low` < 2 ≤ `medium` < 4 ≤
`high` < 8 ≤ `critical`.

### Fragile zones

Two specs can meet in a merge without a file in common: an interface and its implementation, a
schema and its migration, a component and its styles. The history says which files go together:
`git log --no-merges --no-renames --name-only -z` over the last 300 commits of the project (one
call, by argument list, 10 s timeout, 8 MB cap). A commit of more than 20 files (a reformat, a
sweeping rename) says nothing and is left out; two files are coupled once 3 commits changed them
together. Each coupled pair with one file in each spec, neither shared (a shared file is already
scored), adds 1 to the pair's score, at most 3: the history hints, shared files decide. The pair
lists them (`a/x ↔ b/y`), and the view says how many commits were read. On by default, off with
the "Fragile zones" option (`options.fragileZones`, a boolean, validated); paths only, so any
language.

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
6. **Preventive merge check**: two specs the colouring put in one wave, both with a worktree and
   sharing files under the tolerance, are test-merged (below). A real textual conflict adds an
   edge and the plan is computed again, until no such pair is left or a limit is reached.

The result gives the total risk (everything at once) and the residual risk (inside the waves):
their difference is the risk the plan avoids.

### Preventive merge check

The tolerance accepts pairs that share a file on the bet that they edit it in different places.
The bet is checked where it can be: `git merge-tree --write-tree --name-only --no-messages -z`
merges the commits of the two worktrees (`HEAD` of each, read with `git rev-parse`) in the object
store only. No worktree, index, branch or ref changes; the trees it writes are unreachable objects
git collects as usual. Exit 0 is clean; exit 1 with a tree id first is a conflict, and the files
listed after it are shown ("A and B are under the tolerance, but a test merge conflicts on …:
they run in different waves"). Anything else (no common history, a git older than 2.38, a
timeout) is no answer: the pair keeps its score and is counted as not checkable.

Only committed work is merged: what a worktree has not committed yet still counts in the score,
not in the test merge. Riskiest pairs first, at most 24 pairs and 20 s per plan, each call under
its own timeout (8 s, or what is left); pairs left over are counted and shown. Git receives object
ids checked against `^[0-9a-f]{40}$|^[0-9a-f]{64}$`, never a name a branch could be called.

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
when the person leaves the page. Stop ends the run; running tasks keep going.

### A run that survives a restart

After every step (a wave started, a task started, a wave planned again) the renderer sends the
run's state: the project id, the waves in merge order, the current wave (those before it ran),
the advance rule, the parallelism and the tasks already started. The main process writes it to
`<project>/.workpilot/execution-waves-run.json`; a finished or stopped run is removed. Saves go
one after the other; one that fails leaves the run going on in memory.

When a project is selected (and at start-up for the one already selected), the file is read. A
run found there is offered, "interrupted at wave 2 of 3 (saved …)", with **Resume** and
**Abandon**; it is never resumed without the person, and never offered over a run going on.
Resumed, it goes on where it was: tasks already started are not started again, the current wave
waits for its tasks as before, and the view lists the run's waves until a plan is computed.
Abandon removes the file. A file that is unreadable or incoherent is ignored, left as it is, and
the view says so.

## Boundary

`conflictWaves:plan` takes `{ projectId, taskIds?, options? }`. The handler checks every field:
project id shape, at most 200 task ids, each one a spec folder name (letters, digits, marks,
`.` `_` `-`, no separator), each one a backlog or queued task of **that** project; tolerance and
drift threshold bounded numbers, policy in a closed list, fragile zones a boolean. The max parallelism is read from the
project's settings, never from the request. Worktrees are found with `findTaskWorktree`
(resolved, kept inside the project) and read with `git` by argument list, with a timeout and a
cap of 2 000 files. Refusals are tested (`plan-service.test.ts`, `conflict-waves-handlers.test.ts`).

The run channels take a project id (`loadRun`, `clearRun`) or a run state (`saveRun`), never a
path. The project is a registered one; the state is rebuilt field by field (`validateRunState`):
at least one wave, none empty, at most 200 tasks, each a spec folder name and in one wave only,
the current wave within the waves, the advance rule in a closed list, the parallelism 1 to 32,
every started task in a wave; anything else sent is dropped. On disk, the project root is
resolved (`realpath`); `.workpilot` must be a real folder (not a link) that resolves to the
root's own `.workpilot`; the run file may not be a link; the write goes to a fresh temporary file
created exclusively (`wx`, mode `0600`) and renamed over the target; the read checks that the file
opened is the one checked (device and inode), reads at most 256 KB, and wants version 1, a date,
the same project and only tasks the project still has. Refusals are tested (`run-store.test.ts`,
`conflict-waves-handlers.test.ts`), and the git calls against real repositories
(`merge-check.test.ts`, `fragile-zones.test.ts`).

## Still to do

- Symbols and cross imports in the score (renamed symbols, a spec importing what another edits).
- Server mode: a backend route over the same planner (and merge check) for server projects and
  the mobile app; the saved run would then live with the server's project.
- The sprint metrics of the issue (conflicts avoided, resolution time of residual conflicts).
