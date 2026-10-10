# Architecture diagrams (archify)

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Architecture diagrams (archify)

[archify](https://github.com/tt-a1i/archify) (tt-a1i, MIT) renders a small typed
JSON model into a self-contained interactive HTML diagram, and compares two
models into a Before / Delta / After. It is **vendored and committed** at
`apps/backend/vendor/archify` — 74 files, 2.2 MB, pinned by
`scripts/vendor_archify.py` and recorded in `VENDOR.json`.

Committed rather than bootstrapped like the packs under `skills/`, and the
difference is the consumer rather than a change of heart: a pack is read by an
agent working in someone's project, this is a runtime dependency of two features
of the desktop app. Optional would mean a user installs the `.dmg`, opens the
Architecture page and reads "not installed, run this command". `extraResources`
already copies `apps/backend`, so packaging is nothing extra.

The trim is the interesting part of the vendoring script: upstream's own `test/`
(2.0 MB) and its **rendered** `examples/*.html` (3.9 MB) are dropped, the JSON
examples the `SKILL.md` tells an author to read are kept, and
`scripts/check-update.mjs` is dropped because an app that queries a third party
mid-build is not a decision to take silently. The licence is a *required* file —
absent, the script fails rather than skipping it — and any optional file
upstream did not ship is recorded in `VENDOR.json` under `absent_upstream`,
because "attribution quietly stopped being copied" is the failure a silent skip
would hide.

**The analyzer changed jobs.** `architecture_visualizer/analyzer.py` used to
render Mermaid into a `<pre>` and call it the answer, and its heuristics were bad
at that: "every imported identifier starting with a capital is a child
component" collects icons, types and `Button`. As **evidence handed to an
author** the import graph is the strongest material available — it is measured
rather than recalled — and deciding that twelve modules under `agents/` are one
component is the judgement a model can make and a regex cannot. So
`diagram_generator.py` is gone (two diagram generators are two answers to one
question) and `archify/evidence.py` ranks the graph by import degree into a
bounded prompt section.

```
apps/backend/architecture_visualizer/archify/
  runtime.py       where bin/archify.mjs and node are; the doctor
  cli.py           validate / deliver / compare / doctor -> a typed Receipt
  evidence.py      what the codebase says, without a model
  ir.py            load, pin to real code, check id continuity
  authoring.py     write a model, repair while repairing helps
  significance.py  is this task worth mapping? (paths only, no API call)
  delta.py         compare two models; the six states the UI can be in
  task_delta.py    one task's delta, end to end: baseline, significance, author, compare
  phase.py         the `architecture-map` workflow phase, on task_delta
  ../../runners/architecture_visualizer_runner.py   --action map | delta | doctor
```

**Id continuity is the constraint everything else rests on.** `archify compare`
matches components by `id` and by nothing else, so an "after" model authored
from scratch reports every component as removed and re-added — noise wearing the
costume of a finding. The head model is always written *from* the base one under
a keep-every-id contract (`prompts/architecture_map_delta.md`), and
`ir.check_id_continuity` verifies mechanically that it did. Below the threshold
the delta is recorded `unreliable-ids` and the UI says so rather than showing it:
the same reflex as coverage reporting *not applicable* rather than 0%.

**Evidence is optional, deliberately.** archify verifies `components[].sources[]`
by reading git blobs at the pinned revision, not the working tree — so a file the
build has not committed would refuse the entire render. `ir.pin_repository` drops
any source with no blob at that commit, and drops `meta.repository` wholesale
rather than leaving it half-pinned. A diagram without evidence is still true; a
diagram that will not render is nothing. `link_mode: "local-only"` covers forges
other than GitHub and Gitee, whose revision links archify cannot build.

**The repair loop is bounded by progress, not by a round count.** Every refusal
names a stable `code`, the exact `subject`, the measured `evidence` and
`supportedFixes`, so a round that does not lower the error count learned nothing
and the next one will not either. Two such rounds and `authoring.author` stops
and reports the diagnostics truthfully instead of presenting the last candidate
as finished. `MAX_ROUNDS` is a ceiling on top of that, not the mechanism.

The authoring agent (`architecture_visualizer` in `AGENT_CONFIGS`) gets `Write`
and **not** `Bash`: the model writes the JSON, Python runs the renderer. An agent
that could shell out is one `deliver` away from reporting an artifact nobody
validated.

**In the Kanban.** The `architecture-map` phase runs after `qa` — the map must
describe the code QA corrected, not the code that was written — in a fresh
context, at `min_effort: medium`. It is **not** a skill session. It used to be
one: the read-only default agent answered in prose, nothing asked
`significance`, nothing ran archify, and the Delta tab stayed empty on every
build. `archify/phase.py` is its executor (`CUSTOM_EXECUTORS`, like `verify`),
and it runs `task_delta.run_task_delta` — the function the tab's regenerate
button runs through `--action delta`, so the two cannot drift. Two filters gate
it, and it needs both: `when: touches(...)` is a glob and can only say "a `.ts`
changed", which is most tasks, so `significance.assess` decides inside the
phase, from paths alone and before any API call, whether the changed files touch
a modelled component's sources or draw an area the model does not describe yet.
Under the threshold the phase records "no architectural change" and returns
before a session is opened — the same shape as `docs` and its libdocs
preflight. Only authoring the head model needs one, under
`architecture_visualizer`, on the provider the task configured for QA.

The record lands in `<spec_dir>/architecture/` — the spec directory, not the
worktree, because the worktree is removed at merge and "what did this task
change" is asked after the merge. An isolated build makes that three
directories, because the worktree lacks two things (`PhaseContext.source_*`):
the baseline, which `.workpilot/` being gitignored keeps in the main project;
and a spec directory that outlives it. `delta.status.json` names its artifact by
absolute path, so the answer is written straight into the main spec directory,
while the head model — written by the session, which may only write in the
worktree — stays in the worktree's copy and is synced back with the other
post-QA reports (`_sync_spec_back`, after the post-QA window; the QA sync runs
before it). `TaskArchitectureDelta` renders the counts and
the Before/Delta/After, and **renders nothing at all** for `not-significant` or a
mapped delta whose counters are zero; `shouldShowArchitectureDelta` gates the tab
trigger on the same predicate, so those states never produce a tab. A tab that
reads "no change" on most tasks is a tab people stop opening.

| Variable | Default | What it does |
|---|---|---|
| `WORKPILOT_ARCHIFY_HOME` | — | Point at a clone instead of the vendored tree, for moving the pin without touching `vendor/` |
