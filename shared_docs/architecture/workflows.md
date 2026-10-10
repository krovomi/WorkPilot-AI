# Declarative workflows

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../../docs/CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

## Declarative Workflows

`workflows/<name>/workflow.yaml` describes a build as phases; `workflows/engine.py`
resolves it against the effort level the user picked, the provider's capabilities
and the files the task touched. The resolved profile is printed before the build
starts, so the user sees what their effort setting bought.

```bash
pnpm run skills:workflow -- --effort high      # what would run, and what is pruned
pnpm run skills:workflow -- --effort low --provider mistral
```

**On by default.** Set `WORKPILOT_WORKFLOW_ENGINE=0` in `.env-files/.env` to
run the pre-engine pipeline. The default flipped once the engine executed the
phases it declares rather than only pruning them: while most of them were
played by a hard-coded sequence, switching it on bought the printed profile and
little else.

**What the profile shows is what runs.** Every `impl:` of the default workflow
resolves on a fresh clone: `validate_impls` is empty at every effort, and
`tests/test_workflow_engine.py::TestImplementations` fails the build otherwise.
It was not: `brainstorm`, `frontend-design` and `review` named skills of packs
that ship only their `pack.json`, so they were printed in the profile and
answered "could not run"; `spec`, `adversarial-review` and `spec-conformance`
named BMAD skills that need the `_bmad/` runtime in the project being built, so
they stopped before their session on almost every build; and `planning` was
announced pruned at effort `none` while the coder loop planned anyway. The
methodology of the build phases is now WorkPilot's own (`skills/tooling/`:
`tdd-cycle`, `brainstorm-approaches`, `review-lenses`), the upstream packs stay
opt-in through `skills:bootstrap`, and a deterministic phase whose pack declares
a `gate` command is implemented by that gate (`pack_inventory`).

| Phase | Who runs it |
|---|---|
| `brainstorm`, `analyze`, `review` | the engine (`workflows/runner.py`), as one-shot skill sessions |
| `verify`, `verify-replay`, `architecture-map` | the engine, through a dedicated executor (`CUSTOM_EXECUTORS`): Python drives the deterministic steps and opens a session only where a model is needed — `verify/phase.py`, `verify/replay.py` (no model at all), `architecture_visualizer/archify/phase.py` |
| `planning` and `coding` | `run_autonomous_agent`, **driven by the profile** — it decides the dispatch and injects the effort and the declared methodology |
| `design-check` and any deterministic gate | the engine (`workflows/gates.py`) |
| `mobile-design` and `store-readiness` | the engine (`workflows/runner.py`), when the task touches mobile files |
| the `tests-pass` hard gate | the engine (`workflows/hard_gates.py`) |
| `qa` | `qa_loop`, which the profile can switch off |
| `observe` | the engine (`learning_loop/observe.py`) |
| `docs` | the preflight (`libdocs.run_preflight`), before planning — no API call, never pruned |

A skill phase runs where the workflow file declares it. The window is looked up
by phase id in the **declared** order, so inserting a phase into
`workflow.yaml` between two existing ones needs no Python change — and pruning
a phase that bounds a window does not hand its work to the neighbouring one.

**A pack is not a phase.** impeccable ships two things — design commands a
model reads, and 59 detector rules that run locally. Both the engine's
`DETERMINISTIC_PHASES` and the runner's `_ELSEWHERE` used to be keyed on the
*pack*, which made "this check costs no tokens" and "the gate runner owns this
phase" true of everything impeccable implements. Both sets are keyed by phase
id, and the pack still owns the gate *command* (`pack.json` → `gate`), which is
a different question. Only the detector is declared now, as `design-check`
after `coding`: what to aim for before coding is `ui-design-system`'s answer,
deterministic and free, and the `frontend-design` session that used to sit
there never opened — its skill was not on disk — and would have been read by
nobody.

There are **four** windows: before `planning`, between `planning` and `coding`,
between `coding` and `qa`, and after `qa`. The second one is opened from inside
`run_autonomous_agent`, because that function owns both phases it sits between —
which is also why it did not exist until a phase needed it. A phase declared
where no window opens is resolved, printed in the profile the user is shown, and
run by nobody; `test_every_skill_phase_belongs_to_a_window` is what keeps that
from happening quietly.

**One review, with lenses the effort chooses.** `review` runs between `coding`
and `qa` on `tooling/review-lenses`: correctness and tests, and security, at
`medium`; conformance to the acceptance criteria and `traceability.json` from
`high`; the adversarial reading at `ultrathink`. It replaces three passes —
`review` itself, and `adversarial-review` / `spec-conformance`, which ran after
QA, where nothing they found reached a fixer. So `ultrathink` buys a deeper
review rather than a phase, and the profile says so: `high` and `ultrathink`
run the same phases, as do `none` and `low` (planning runs at every level; the
two differ in thinking budget only).

**Every skill phase is read by the agent that comes next** (`workflows/handoff.py`).
`run_skill_phase` writes each report to `<spec_dir>/workflow/<phase>.md`; until
the handoff, only `workflow/verify.md` was ever read back. The rule is the
declared order, so a phase inserted into `workflow.yaml` needs no Python change:
a report goes to the next of `planning` (the planner prompt), `coding` (each
coder subtask, as its head and path, since that prompt is paid per subtask) and
`qa` (the QA reviewer, told that each finding is a claim to verify). Phases with
a reader of their own (`ui-design-system` → `uiux_section`, `verify` →
`verify_section`, `architecture-map` → its record) are not handed over twice,
and a phase declared after `qa` has no consumer in the build. What is handed
over is cleaned, scanned by `injection_guard` (only `blocked` withholds — a
security review quoting suspicious code is `suspect` by nature), bounded
(4 000 characters per report, 8 000 per section) and fenced as data. The QA
fixer is not a consumer: it works from what the reviewer decided.

`analyze` is the phase in that second window: `spec.md` and
`implementation_plan.json` read together, once, before any code exists. The
mechanical half of the question — which requirement no subtask claims — is
already in `traceability.json` by then, so the skill is told to cite it rather
than recompute it, and spends its budget on what a parser cannot see: the two
documents contradicting each other, a plan that breaks the project's own
conventions, an acceptance criterion nothing can verify. It runs read-only
(`spec_validation`) and in a fresh context: a reader who inherits the planner's
reasoning is not a second opinion, and a reviewer who can rewrite the document
ends up reviewing his own.

`impl:` reaches the two built-in phases as well. `coding` declares
`tooling/tdd-cycle`: the skill is the *methodology*, the
coder loop is the *executor*, and the engine names the skill file in the
prompt rather than pasting ten kilobytes of it into every subtask session.
Builtins are recognised by **phase id**, never by their impl string — keying on
the impl would mean swapping the methodology in YAML silently demotes `coding`
to a one-shot session and loses the coder loop.

**`roster:` — which specialists a phase gets.** Separate from `agent:` on purpose. The
`agent:` value is an `AGENT_CONFIGS` entry, and it decides two unrelated things at once:
the tool allowlist (with `create_client` putting the read-only entries in permission mode
`plan`) *and*, through `PHASE_ALIASES`, which subagent roster is composed. Binding them
meant a read-only audit could only reach the right specialists by being handed write
access.

Three phases were falling through `PHASE_ALIASES` to the Kanban default, which is
`code-reviewer` + `test-runner`:

| Phase | Ran under | Got | Should get |
|---|---|---|---|
| `brainstorm` | `spec_critic` | a `test-runner`, before any code exists | `spec` — `prior-art-finder`, `constraint-collector` |
| `analyze` | `spec_validation` | a `test-runner`, before any code exists | `planner` — `architecture-analyst` answers "does this plan break the project's conventions" |
| `spec-conformance` (since removed) | `spec_validation` | not `qa-acceptance-checker` | `qa` — the subagent its own description in `workflow.yaml` had named since the phase was written |

`spec_critic` now maps in `PHASE_ALIASES`; `spec_validation` does not, because `analyze`
reads a plan before any code exists, which is the planner's question rather than QA's.
It declares `roster: planner` in the workflow file instead, and `verify` declares
`roster: qa`, which is how `qa-acceptance-checker` reaches a phase before QA now that
the acceptance audit is a lens of `review` rather than a pass after QA. An unknown roster name logs and falls back rather than raising: a typo in a
workflow file should cost the right specialists, not the build.

This matters beyond tidiness — the roster is context the parent pays for on **every
turn**, so a mismatched roster is not merely unhelpful, it is billed. Hence three
rules in `agents.subagents.resolve`:

- **Every `AGENT_CONFIGS` entry but `coder` names its roster** in `PHASE_ALIASES`
  (`test_every_agent_config_names_its_roster`). The PR orchestrators fell through to
  the Kanban roster and carried a code-reviewer, a test-runner and a spec-explorer on
  top of the specialists they bring; they are `solo` now.
- **The cap (seven) counts the caller's agents.** It used to run before they were
  merged. Generic defaults go first; nothing the caller named is ever dropped.
- **An overlay specialises a roster, it does not start one.** Language and mobile
  overlays fold the project's commands into `test-runner`, and the mobile specialists
  join only a phase that has a roster of its own.
- **One definition per role, rosters by name.** `phases.SPECS` and `ROSTERS`,
  `pr_review.PR_SPECIALISTS` and `PR_ROSTERS`, `mobile.MOBILE_SPECS`. A role two
  rosters share is one definition: the QA's `qa-test-evidence` was the board's
  `test-runner`, and `spec-explorer` / `codebase-surveyor` were `architecture-analyst`
  in other words (lot L11).

The live PR review runs its specialists as sessions of their own, under
`pr_reviewer`, and passes `roster="solo"`: a specialist is a leaf of the fan-out, not
a second fan-out.

Two rules the resolver enforces and that are easy to break:

- **A `hard_gate` is never pruned by effort**, and it is evaluated after the
  build: `verify` declares `tests-pass`, and `workflows/hard_gates.py` reports
  whether it held. A gate that failed is reported as failed; one with no
  evidence to judge is reported as unknown and does not block, because
  refusing on an absent signal would make every project without a QA report
  unbuildable.
- **A deterministic phase is never pruned either.** It costs no API call, so
  there is no effort level at which skipping it saves anything — and its verdict
  is an *external* signal the learning loop may count as corroboration.

A phase asking for `subagent-per-task` on a provider with no subagents degrades
to sequential execution with a context reset, recorded on the resolved phase
rather than silently pretended — and the degradation is now *read at
execution*: `create_client(use_subagents=False)` suppresses the roster instead
of handing one to a provider that will drop it. `fresh-context` is read too: a
phase dispatched that way does not rehydrate the transcript a pending
`AUTO_CLAUDE_RESUME_SESSION_ID` points at, because a reviewer carrying the
writer's reasoning is not a second opinion. The marker is restored afterwards,
so the coder loop's own resume survives a review pass between two iterations.

### The resolved profile in the UI

The same profile the CLI banner prints is served to the Kanban at
`GET /api/workflow-profile/?project_dir=…&spec_id=…` and rendered in the task
detail modal (`WorkflowProfileCard`). Dropped phases are returned **in their
declared position with their reason**, plus a per-level phase count: a list of
survivors cannot answer "what would one level more give me", which is the
question someone is actually asking in front of an effort selector.

The endpoint resolves the provider through `get_phase_provider`, never
`_get_active_provider` — the latter consumes the single-shot
RESUME_WITH_PROVIDER marker, and an endpoint the UI may poll must not eat a
choice the next build was meant to honour.

## Workflow Logger

Centralized logging system for tracking all AI agents, skills, hooks and workflows:

**Features:**
- Structured logging with visual indicators (🤖 agents, ⚡ skills, 🪝 hooks)
- Automatic duration tracking and trace IDs
- Both human-readable and JSON structured output
- Active trace monitoring

**Usage:**
```python
from core.workflow_logger import workflow_logger

# Log agent execution
trace_id = workflow_logger.log_agent_start(
    "Claude Code", "refactor_task", {"file": "app.py"}
)
workflow_logger.log_agent_end(
    "Claude Code", "success", {"changes": 5}, trace_id=trace_id
)

# Log skill execution
skill_trace = workflow_logger.log_skill_start(
    "framework-migration", "analyze", {"framework": "react"}
)
workflow_logger.log_skill_end(
    "framework-migration", "success", {"migrations_found": 3}, trace_id=skill_trace
)

# Monitor active traces
active = workflow_logger.get_active_traces()
```
