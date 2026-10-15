# Agents Module

The agent layer of the backend: the autonomous build loop (planner → coder), the
session runner, memory access, the specialised agents the UI exposes, and the
**subagent registry** every provider-backed session composes its specialists from.

## Layout

```
apps/backend/agents/
├── __init__.py              # Public API (lazy exports, see below)
├── base.py                  # Shared constants (AUTO_CONTINUE_DELAY_SECONDS, HUMAN_INTERVENTION_FILE)
├── base_agent.py            # BaseAgent abstraction shared by the specialised agents
├── scanner_base.py          # Base classes for "scanner-style" agents
├── utils.py                 # Git helpers and implementation-plan access
├── memory.py                # Session memory in the shared brain
├── memory_manager.py        # Memory diagnostics / context retrieval used by the public API
├── session.py               # run_agent_session(), post_session_processing()
├── session_history.py       # Record and replay sessions
├── planner.py               # Follow-up planner
├── coder.py                 # run_autonomous_agent(): the main autonomous loop
├── hot_swap.py              # Switch provider / model / effort during a running phase
├── loop_detection.py        # Anti-burnout loop detector for the coder
├── debugger.py, debugger_store.py   # Breakpoints, inspection, persisted debug state
├── decision_logger.py       # Decision-tree capture for the UI
├── agent_audit.py           # Audit-trail facade for coder / planner / QA
├── feedback_learning.py     # Collect user feedback on agent outputs
├── feature_wiring.py        # Wiring of the model router / cognitive context features
├── pair_programming.py      # Interactive pair-programming mode
├── test_generator.py        # Streaming unit / integration test generation
├── refactorer.py            # Refactoring with smell detection
├── documenter.py            # Documentation generation
├── migration_agent.py       # Framework / library migration (+ skill wrapper)
├── impact_analyzer.py       # PR impact analysis
├── pr_template_filler.py    # Fills the repository's PR template
├── swarm/                   # Wave-based parallel execution of independent subtasks
├── tools_pkg/               # Tool registry, models and permissions per agent type
└── subagents/               # The subagent registry — see below
```

## Public API

```python
from agents import (
    run_autonomous_agent,       # coder.py
    run_followup_planner,       # planner.py
    run_agent_session,          # session.py
    post_session_processing,
    get_memory_context,         # memory_manager.py
    save_session_memory,
    debug_memory_system_status,
    get_latest_commit,          # utils.py
    get_commit_count,
    load_implementation_plan,
    find_subtask_in_plan,
    find_phase_for_subtask,
    sync_spec_to_source,
)
```

Exports are resolved lazily (`__getattr__` in `__init__.py`) to avoid circular
imports. There is no longer a root `agent.py` facade: import from `agents` or from
the submodule directly.

## Subagents

A *subagent* is a specialist the parent session can delegate to (Claude Agent SDK
`agents=`, Copilot's equivalent). WorkPilot does not let each phase invent its own:
every specialist is declared once, in `agents/subagents/`, and each run gets a
**roster** composed from it by `agents.subagents.resolve()`, called from
`core/client.py` (`create_client` for Claude, `create_agent_client` for the other
providers).

### Where the specialists are declared

| File | Content |
|---|---|
| `subagents/phases.py` | `SPECS` (one `AgentSpec` per role: `code-reviewer`, `test-runner`, `architecture-analyst`, `dependency-tracer`, `qa-acceptance-checker`, `security-auditor`, `regression-hunter`, `test-coverage-auditor`, `evidence-collector`, `prior-art-finder`, `constraint-collector`), `ROSTERS` (lists of names per phase) and `PHASE_ALIASES` (agent_type → phase) |
| `subagents/languages/` | One overlay per stack (`python`, `typescript`, `dotnet`, `go`, `rust`, `java`): test / lint commands and notes, folded into the `test-runner` prompt |
| `subagents/mobile.py` | The mobile overlay: `device-runner`, `store-readiness-auditor`, build commands per framework |
| `subagents/pr_review.py` | The PR-review specialists (`PR_SPECIALISTS`, `PR_ROSTERS`); their prompts live in `prompts/github/pr_*.md` and they are read-only (`Read`, `Grep`, `Glob`) |

Specs are plain data (`AgentSpec`) and converted to SDK `AgentDefinition`s only at
the point of use, so the same registry can be emitted to other harnesses.

### Rosters by phase

| Phase | agent_types (examples) | Roster |
|---|---|---|
| `kanban` | `coder` and any unlisted type | `code-reviewer`, `test-runner`, `architecture-analyst` |
| `planner` | `planner`, `architect`, `impact_analyzer` | `architecture-analyst`, `dependency-tracer` |
| `qa` | `qa_reviewer`, `qa_fixer` | `qa-acceptance-checker`, `test-runner` |
| `verify` | `verifier` | `test-runner` |
| `review` | `pr_reviewer`, `architecture_reviewer` | `security-auditor`, `regression-hunter`, `test-coverage-auditor` |
| `research` | `ideation`, `insights`, `analyzer`, `roadmap_discovery`… | `architecture-analyst`, `evidence-collector` |
| `spec` | `spec_writer`, `spec_critic`, `spec_researcher`… | `prior-art-finder`, `constraint-collector` |
| `solo` | commit message, PR template, PR orchestrators, `migration` | none |

A workflow phase can pick its roster independently of its permissions with
`roster:` in `workflows/*/workflow.yaml` (e.g. `roster: solo` on the review-lenses
phase, whose lenses already are the specialists).

### How `resolve()` composes a roster

1. **Provider check** — only providers declared `subagents: native` in
   `capabilities/providers.yaml` (today Claude and Copilot) get a roster; the others
   get `None`. The workflow engine's `sequential-reset` dispatch also disables it.
2. **Phase defaults** — `ROSTERS[phase]`.
3. **Language overlays** — the stack detected on disk specialises `test-runner`
   with concrete commands (`dotnet test --nologo`, `pytest -x`, …). Overlays only
   specialise an existing roster; they never give one to a `solo` phase.
4. **Mobile overlay** — on a phone project, adds `device-runner` and
   `store-readiness-auditor`, applied last.
5. **Caller-supplied agents** — always win (e.g. the PR orchestrators' specialists).
6. **Cap** — `MAX_ROSTER = 7`, counting the caller's agents. Generic phase defaults
   are dropped first (alphabetically, so the result is deterministic); `test-runner`,
   caller agents and mobile specialists are protected.

For non-Anthropic providers, tier aliases such as `sonnet` are rewritten to
`inherit`, so the specialist runs on the model the user chose.

### At run time

`harness/application/subagents.py` handles what comes back: each result is capped
(`RESULT_CAP_TOKENS = 2000`, `harness/domain/subagents.py`), marked when truncated,
and delimited as untrusted data before the parent reads it. Launches are staggered
so parallel subagents share the prompt cache.

### Emitted to the IDE harnesses

`skills_registry/agents.py` emits the same registry, plus the persona files packs
ship under `skills/<pack>/agents/*.md` (e.g. `dotnet/net-architect`,
`mobile/android-engineer`), into `.agents/agents/` (committed). The per-harness
mirrors (`.github/agents/`, `.codex/agents/`, `.claude/agents/`) are not emitted by
default and are git-ignored when they are; tool names are translated through
`capabilities/harnesses.yaml`. Regenerate with `pnpm run skills:build`.

Note: the pack personas are for a developer driving Copilot, Codex or Claude Code
directly. The build pipeline does not put them in its rosters; on a .NET project
it uses the `dotnet` overlay (commands folded into `test-runner`).

### Adding a specialist

1. Declare an `AgentSpec` in `SPECS` (or in the mobile / PR registry).
2. Add its name to the relevant `ROSTERS` entry, or to a language overlay's
   `extra_agents` if it only makes sense on one stack.
3. Map any new agent_type in `PHASE_ALIASES` (`test_subagents_coverage` enforces it).
4. Run `pnpm run skills:build` to re-emit the harness definitions.

## Testing

```bash
pytest apps/backend/agents/
pytest tests -k subagent
```
