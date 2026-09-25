# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

WorkPilot AI is an autonomous multi-agent coding framework that plans, builds, and validates software for you. It's a monorepo with a Python backend (CLI + agent logic) and an Electron/React frontend (desktop UI).

> **Deep-dive reference:** [Architecture deep dives](../shared_docs/README.md) | [Configuration reference](../shared_docs/CONFIGURATION.md) | **Frontend contributing:** [apps/frontend/CONTRIBUTING.md](../apps/frontend/CONTRIBUTING.md)

## Table of Contents

- [Product Overview](#product-overview)
- [Critical Rules](#critical-rules)
- [Project Structure](#project-structure)
- [Commands Quick Reference](#commands-quick-reference)
- [Backend Development](#backend-development)
  - [Claude Agent SDK Usage](#claude-agent-sdk-usage)
  - [Agent Prompts](#agent-prompts)
  - [Spec Directory Structure](#spec-directory-structure)
  - [Where the implementation plan actually is](#where-the-implementation-plan-actually-is)
  - [Requirement Traceability](#requirement-traceability)
  - [spec-kit projects](#spec-kit-projects)
  - [Memory System (Graphiti)](#memory-system-graphiti)
  - [Skills System](#skills-system)
  - [Memory Search (mem-search)](#memory-search-mem-search)
  - [Le cerveau partagé (Obsidian + Graphify + MCP)](#le-cerveau-partagé-obsidian--graphify--mcp)
  - [Where generated tests are written](#where-generated-tests-are-written)
  - [What generated tests are written against](#what-generated-tests-are-written-against)
  - [Library Documentation (libdocs)](#library-documentation-libdocs)
  - [Token savings (rtk)](#token-savings-rtk)
  - [Clean generated files (watermarks)](#clean-generated-files-watermarks)
  - [Architecture diagrams (archify)](#architecture-diagrams-archify)
  - [Mobile applications (Android and Apple)](#mobile-applications-android-and-apple)
  - [Competitive rounds (Bounty Board)](#competitive-rounds-bounty-board)
  - [Declarative Workflows](#declarative-workflows)
  - [Workflow Logger](#workflow-logger)
  - [Pause, resume, and how a phase reports failure](#pause-resume-and-how-a-phase-reports-failure)
  - [Le mode hors-ligne : une barrière, ou un défaut](#le-mode-hors-ligne--une-barrière-ou-un-défaut)
- [Frontend Development](#frontend-development)
  - [Tech Stack](#tech-stack)
  - [Path Aliases](#path-aliases)
  - [State Management (Zustand)](#state-management-zustand)
  - [Styling](#styling)
  - [IPC Communication](#ipc-communication)
  - [Background work and the sidebar](#background-work-and-the-sidebar-storesactivity-storets)
  - [Le pourcentage d'une tâche](#le-pourcentage-dune-tâche-sharedprogressts)
  - [Les critères d'acceptation en puces](#les-critères-dacceptation-en-puces-task-detailacceptance-criteria-draftts)
  - [Architectures et historique de construction](#architectures-et-historique-de-construction-visual-to-code)
  - [Provider × LLM × effort, par page](#provider--llm--effort-par-page-sharedutilspage-llmts)
  - [Qui combat dans le Mode Arena](#qui-combat-dans-le-mode-arena-sharedutilsarena-contendersts)
  - [L'adresse qu'ouvre l'émulateur](#ladresse-quouvre-lémulateur-sharedutilsemulator-landingts)
  - [Le chemin d'une tâche, en graphe](#le-chemin-dune-tâche-en-graphe-sharedutilschange-graphts)
  - [Agent Management](#agent-management)
  - [Claude Profile System](#claude-profile-system)
  - [Terminal System](#terminal-system)
  - [Le lien d'un écran d'authentification](#le-lien-dun-écran-dauthentification-terminalterminal-interactionsts)
- [Code Quality](#code-quality)
- [i18n Guidelines](#i18n-guidelines)
- [Cross-Platform](#cross-platform)
- [E2E Testing (Electron MCP)](#e2e-testing-electron-mcp)
- [Chrome DevTools MCP](#chrome-devtools-mcp)
- [Integrated Tools](#integrated-tools)
  - [grepai Integration](#grepai-integration)
- [Running the Application](#running-the-application)
- [Troubleshooting](#troubleshooting)

## Product Overview

WorkPilot AI is a desktop application (+ CLI) where users describe a goal and AI agents autonomously handle planning, implementation, and QA validation. All work happens in isolated git worktrees so the main branch stays safe.

**Core workflow:** User creates a task → Spec creation pipeline assesses complexity and writes a specification → Planner agent breaks it into subtasks → Coder agent implements (can spawn parallel subagents) → QA reviewer validates → QA fixer resolves issues → User reviews and merges.

**Main features:**

- **Autonomous Tasks** — Multi-agent pipeline (planner, coder, QA) that builds features end-to-end
- **Kanban Board** — Visual task management from planning through completion with preview/emulator support
- **Agent Terminals** — Up to 12 parallel AI-powered terminals with task context injection
- **Insights** — AI chat interface for exploring and understanding your codebase
- **Roadmap** — AI-assisted feature planning with strategic roadmap generation
- **Ideation** — Discover improvements, performance issues, and security vulnerabilities
- **GitHub/GitLab Integration** — Import issues, AI-powered investigation, PR/MR review and creation
- **Azure DevOps/Jira Integration** — Import work items, sync statuses
- **Microsoft Teams Notifications** — Webhook-based notifications for task completion and PR creation
- **Changelog** — Generate release notes from completed tasks
- **Memory System** — Graphiti-based knowledge graph retains insights across sessions
- **Isolated Workspaces** — Git worktree isolation for every build; AI-powered semantic merge
- **Self-Healing** — Incident response system with CI/CD failure analysis, proactive monitoring, and production responder
- **Pixel Office** — Multi-agent coordination visualization with task queue UI
- **Learning Loop** — Analytics and learning system for continuous improvement
- **App Emulator** — Preview running applications directly in the Kanban board (human review, AI review, done columns)
- **Mobile Apps (Android & Apple)** — Build smartphone applications from the Kanban: stack detection (native Android, native iOS, Flutter, React Native/Expo, .NET MAUI, Kotlin Multiplatform, Capacitor), a device picker over the machine's real emulators and simulators, run-on-device with a captured frame, per-task platform targets, and the mobile phases and specialists of the agent chain
- **Chrome DevTools MCP** — Browser automation for coding and QA agents via Chrome DevTools Protocol
- **Pair Programming** — AI-assisted pair programming mode
- **Code Migration** — AI-guided code migration workflows
- **Design-to-Code** — Convert designs into code implementations
- **Performance Profiler** — AI-powered performance analysis and profiling
- **Documentation Agent** — Automated documentation generation and maintenance
- **Smart Estimation** — AI-based task complexity and effort estimation
- **Test Generation** — Automated test creation for existing code
- **Conflict Predictor** — AI-powered git conflict prediction
- **Arena Mode** — Compare AI model outputs side-by-side
- **MCP Marketplace** — Browse and install Model Context Protocol servers
- **Multi-Tenancy & RBAC** — In server mode, one deployment serves several isolated organizations, with fine-grained `domain.action` permissions composed into built-in and custom roles, an administration console (members, roles, organizations, invitations, audit, quotas) and a per-tenant control dashboard
- **Flexible Authentication** — Use a Claude Code subscription (OAuth) or API profiles with any Anthropic-compatible endpoint (e.g., Anthropic API, z.ai for GLM models)
- **Multi-Account Swapping** — Register multiple Claude accounts; when one hits a rate limit, WorkPilot AI automatically switches to an available account
- **Cross-Platform** — Native desktop app for Windows, macOS, and Linux with auto-updates

## Critical Rules

**Claude Agent SDK only** — All AI interactions use `claude-agent-sdk`. NEVER use `anthropic.Anthropic()` directly. Always use `create_client()` from `core.client`.

**i18n required** — All frontend user-facing text MUST use `react-i18next` translation keys. Never hardcode strings in JSX/TSX. Add keys to both `en/*.json` and `fr/*.json`.

**Platform abstraction** — Never use `process.platform` directly. Import from `apps/frontend/src/main/platform/` or `apps/backend/core/platform/`. CI tests all three platforms.

**No time estimates** — Never provide duration predictions. Use priority-based ordering instead.

**Authorization is the server's job** — In server mode every route carries a permission (`server/authz/`), and the UI only *masks* what the user cannot do. Never treat a hidden button as a control. A client-supplied filesystem path (`project_dir`, `spec_dir`, `file_path`…) is refused outright: identify a project by `project_id` and let the server resolve its own checkout.

**Auth belongs to the provider that needs it** — the Claude Code OAuth token gates
Claude builds only. Ask `core.auth.provider_requires_claude_oauth(provider)` before
demanding it, and resolve the provider with `core.client.peek_active_provider` (never
`_get_active_provider`, which consumes the single-shot RESUME_WITH_PROVIDER marker).
A blanket `if not get_auth_token()` is how a task configured for Ollama got accepted by
the frontend — which asks the same question and answers it correctly — and refused by
the backend one second later, over a service it never talks to.

**PR target** — Always target the `develop` branch for PRs to krovomi/WorkPilot-AI, NOT `main`.

## Project Structure

WorkPilot-AI/
├── apps/
│   ├── backend/                      # Python backend/CLI — ALL agent logic
│   │   ├── core/                     # client.py, auth.py, worktree.py, platform/, workflow_logger.py
│   │   ├── security/                 # Command allowlisting, validators, hooks
│   │   ├── agents/                   # planner, coder, session management
│   │   ├── qa/                       # reviewer, fixer, loop, criteria
│   │   ├── spec/                     # Spec creation pipeline
│   │   ├── skills/                   # Executable Python skills (angular, migration)
│   │   ├── cli/                      # CLI commands (spec, build, workspace, QA)
│   │   ├── context/                  # Task context building, semantic search
│   │   ├── runners/                  # 66 standalone runners (spec, roadmap, insights, github, self-healing, etc.)
│   │   ├── services/                 # Background services, recovery orchestration
│   │   ├── integrations/             # graphiti/, linear, github, windsurf_proxy
│   │   ├── project/                  # Project analysis, security profiles
│   │   ├── merge/                    # Intent-aware semantic merge for parallel agents
│   │   └── prompts/                  # Agent system prompts (.md)
│   └── frontend/                     # Electron desktop UI
│       └── src/
│           ├── main/                 # Electron main process
│           │   ├── agent/            # Agent queue, process, state, events
│           │   ├── claude-profile/   # Multi-profile credentials, token refresh, usage
│           │   ├── terminal/         # PTY daemon, lifecycle, Claude integration
│           │   ├── platform/         # Cross-platform abstraction
│           │   ├── ipc-handlers/     # 106 handler modules by domain
│           │   ├── services/         # SDK session recovery, profile service
│           │   └── changelog/        # Changelog generation and formatting
│           ├── preload/              # Electron preload scripts (electronAPI bridge)
│           ├── renderer/             # React UI
│           │   ├── components/       # UI components (onboarding, settings, task, terminal, github, etc.)
│           │   ├── stores/           # 96 Zustand state stores
│           │   ├── contexts/         # React contexts (ViewStateContext)
│           │   ├── hooks/            # Custom hooks (useIpc, useTerminal, etc.)
│           │   ├── styles/           # CSS / Tailwind styles
│           │   └── App.tsx           # Root component
│           ├── shared/               # Shared types, i18n, constants, utils
│           │   ├── i18n/locales/     # en/*.json, fr/*.json
│           │   ├── constants/        # themes.ts, etc.
│           │   ├── types/            # 30+ type definition files
│           │   └── utils/            # ANSI sanitizer, shell escape, provider detection
│           └── types/                # TypeScript type definitions
├── src/                              # Shared connectors and utilities
│   └── connectors/
│       └── grepai/                   # grepai semantic search integration
├── docs/                             # Documentation (this file, CLI usage, release, security)
├── shared_docs/                      # Long-form reference (configuration, architecture)
├── tests/                            # Backend test suite
└── scripts/                          # Build and utility scripts

## Commands Quick Reference

### Setup

**Prerequisites:**
- Python 3.12+ with `uv` package manager
- Node.js 20+ with `pnpm 8+` package manager
- Git

```bash
# Install all dependencies from root
pnpm run install:all

# Or separately:
cd apps/backend && uv venv && uv pip install -r requirements.txt
cd apps/frontend && pnpm install
```

### Backend
```bash
cd apps/backend
python runners/spec_runner.py --interactive     # Create spec interactively
python runners/spec_runner.py --task "..."      # Create from task
python run.py --spec 001                        # Run autonomous build
python run.py --spec 001 --qa                   # Run QA validation
python run.py --spec 001 --merge                # Merge completed build
python run.py --list                            # List all specs
```

### Frontend
```bash
cd apps/frontend
pnpm run dev             # Dev mode (Electron + Vite HMR)
pnpm run build           # Production build
pnpm run test            # Vitest unit tests
pnpm run test:watch      # Vitest watch mode
pnpm run lint            # Biome check
pnpm run lint:fix        # Biome auto-fix
pnpm run typecheck       # TypeScript strict check
pnpm run package         # Package for distribution
```

### Testing

| Stack | Command | Tool |
|-------|---------|------|
| Backend | `pytest tests/ -v` (venv: `.venv/bin` on Unix, `.venv/Scripts` on Windows) | pytest |
| Frontend unit | `cd apps/frontend && pnpm test` | Vitest |
| Frontend E2E | `cd apps/frontend && pnpm run test:e2e` | Playwright |
| All backend | `pnpm run test:backend` (from root) | pytest |

### Releases
```bash
node scripts/bump-version.js patch|minor|major  # Bump version
git push && gh pr create --base main             # PR to main triggers release
```

See [RELEASE.md](RELEASE.md) for the full release process.

## Backend Development

### Claude Agent SDK Usage

Client: `apps/backend/core/client.py` — `create_client()` returns a configured `ClaudeSDKClient` with security hooks, tool permissions, and MCP server integration.

Model and thinking level are user-configurable (via the Electron UI settings or CLI override). Use `phase_config.py` helpers to resolve the correct values:

```python
from core.client import create_client
from phase_config import get_phase_model, get_phase_thinking_budget

# Resolve model/thinking from user settings (Electron UI or CLI override)
phase_model = get_phase_model(spec_dir, "coding", cli_model=None)
phase_thinking = get_phase_thinking_budget(spec_dir, "coding", cli_thinking=None)

client = create_client(
    project_dir=project_dir,
    spec_dir=spec_dir,
    model=phase_model,
    agent_type="coder",  # planner | coder | qa_reviewer | qa_fixer
    max_thinking_tokens=phase_thinking,
)

# Run agent session (uses context manager + run_agent_session helper)
async with client:
    status, response = await run_agent_session(client, prompt, spec_dir)
```

Working examples: `agents/planner.py`, `agents/coder.py`, `qa/reviewer.py`, `qa/fixer.py`, `spec/`

### Agent Prompts (`apps/backend/prompts/`)

37 root-level prompts + 18 GitHub-specific prompts in `prompts/github/`.

| Category | Prompts |
|----------|---------|
| **Core Build** | planner.md, coder.md, coder_recovery.md |
| **QA** | qa_reviewer.md, qa_fixer.md, validation_fixer.md |
| **Spec Pipeline** | spec_gatherer.md, spec_researcher.md, spec_writer.md, spec_critic.md, spec_quick.md, complexity_assessor.md |
| **Ideation** | ideation_code_improvements.md, ideation_code_quality.md, ideation_documentation.md, ideation_performance.md, ideation_security.md, ideation_ui_ux.md |
| **Incidents** | incident_cicd_analyzer.md, incident_proactive_analyzer.md, incident_production_responder.md |
| **Analysis** | architecture_reviewer.md, architecture_visualizer.md, breaking_change_detector.md, performance_profiler.md, insight_extractor.md, learning_analyzer.md |
| **Advanced** | browser_agent.md, code_migration.md, documentation_agent.md, environment_cloner.md, multi_repo_planner.md, intent_templates.md, followup_planner.md |
| **Roadmap** | roadmap_discovery.md, roadmap_features.md, competitor_analysis.md |
| **GitHub** | issue_analyzer.md, issue_triager.md, pr_reviewer.md, pr_orchestrator.md, pr_parallel_orchestrator.md, pr_finding_validator.md, pr_template_filler.md, pr_ai_triage.md, pr_codebase_fit_agent.md, + 9 more |

Duplicate detection and issue auto-fix are listed as features above but are not
prompt-driven: `runners/github/duplicates.py` compares embeddings, and
`runners/github/orchestrator.py` drives `auto_fix_issue`. The
`duplicate_detector.md` and `pr_fixer.md` this table used to name were left over
from an earlier design and loaded by nothing.

### Spec Directory Structure

Each spec in `.workpilot/specs/XXX-name/` contains: `spec.md`, `requirements.json`, `context.json`, `implementation_plan.json`, `qa_report.md`, `QA_FIX_REQUEST.md`

### Where the implementation plan actually is

> *Planning failed: the model did not produce a valid implementation_plan.json
> (unparseable or missing `phases`). — No phases defined — No subtasks defined
> in any phase*

That sentence was the answer to a question nobody had asked. The validator
reads one path, in one shape, and reports what it did not find there; it was
then repeated three times and the build gave up. Three other things are true
far more often than "the model produced nothing", and none of them costs
another planning session to fix:

| What happened | Where the plan was |
|---|---|
| PHASE 3 of `prompts/planner.md` spelled the destination as a **relative** `implementation_plan.json`, which resolves against the worktree root | `<project_dir>/implementation_plan.json` — the file `_cleanup_stray_root_plan` used to **delete** |
| the model invented a filename | `plan.json`, `tasks.json`, `subtasks.json`, in the spec directory |
| it wrote the right file in a shape the schema does not name | `tasks` / `steps` / `stages` instead of `phases`, one level of `{"implementation_plan": {…}}`, `phases` keyed by id, a subtask that is a bare string, the whole document inside a ```` ```json ```` fence |
| it wrote **`"phases": []`** and put the work one key lower | `{"feature": …, "phases": [], "tasks": [{…}]}` — the shape PHASE 3 warns against by name, which is why a model produces it |
| its Write was **refused** and the content dropped | the `tool_use` input in `conversation.<provider>-<model>.jsonl` |
| it never called Write at all | the JSON is in the planner's own response |

`spec/plan_recovery.py` answers the question in two halves, both usable alone:

| Function | Answers |
|---|---|
| `extract_json_document` | the first complete JSON document in a blob that may be fenced or wrapped in prose — depth-counted, so a `"map[0] of {x}"` inside a string does not close it early |
| `normalize_plan_shape` | a parsed *anything* → `phases[].subtasks[]`, or `None` |
| `recover_plan` / `write_recovered_plan` | the same normalization applied to every place the plan could be, writing the winner to the one path WorkPilot reads |

`validate_pkg.auto_fix` calls the first two on the file the validator reads, so
the CLI and the spec pipeline get the reshaping too; `agents/coder.py` calls
`recover_plan` as the third step of `_validate_and_fix_implementation_plan`,
after validation and after auto-fix, and **prints where the plan came from** —
this is the one point where WorkPilot builds from a file it moved or reshaped
on the model's behalf, and a silent rewrite would leave the next reader
comparing the plan against a transcript that does not match it.

**Reshaping is not inventing.** The only things added are the fields the schema
requires and the model left implicit: `status: pending`, ids, a phase to hold a
flat list. A *description* is never synthesised, because that is the only field
carrying a decision. When nothing anywhere holds a single subtask,
`normalize_plan_shape` returns `None`, and planning fails with exactly the
message above — which is then true. A plan WorkPilot made up would be worse
than the error: the coder would spend a whole build implementing it.

**An empty `phases` proves nothing.** `normalize_plan_shape` used to read the
key it found and stop: `phases` was *present*, so the flat list one key lower
was never looked at, and a plan whose subtasks were right there reached the
validator as "No phases defined / No subtasks defined in any phase" — the one
report that claims a model produced nothing while it had produced a plan. The
phases key and the flat list are now both tried, in that order, and only a
document where neither carries a subtask returns `None`.

**A refused write is where the plan of a non-Claude provider goes to die.**
The recovery above reads files and response text, and a provider that does not
use the Claude SDK puts its plan in neither: it calls `Write`, and
`tool_executor._write_implementation_plan` used to reject any content
`json.loads` refused — a ```json fence, a sentence in front of it — and return
the error. Nothing was written, so no file existed to repair; the plan was in
the tool call, not in the prose, so there was nothing to salvage from the
response either. Three planning sessions were spent on a plan WorkPilot had
been handed and thrown away. Two layers answer it now, and they are
independent on purpose:

| Layer | Answers |
|---|---|
| `tool_executor._write_implementation_plan` | the fence and the surrounding prose are stripped by the same `extract_json_document`, and the document is written — even when it is not an object, because a bare `phases` array is still the only copy. Only content with no JSON document in it is refused, and that error still goes back to the model |
| `plan_recovery._plan_from_tool_calls` | the plan out of a `Write` that never landed, read from the conversation log's `tool_use` inputs, newest call first. The last place it can be, and the one both other sources miss |

The second layer is as strict about the destination as the file search is: the
asked-for name counts anywhere, an invented name only when the write was aimed
*inside* the spec directory, and a relative path never — a tool call's content
is any file the model wrote, and building an arbitrary one is worse than
failing. A write aimed at `src/Program.cs` is not a plan however well its
content parses.

**A document that is not an object is reported, not crashed on.** Every check
in `ImplementationPlanValidator` reads the plan as a mapping, so a model that
wrote the bare `phases` array took the build down with an `AttributeError` deep
in validation and the card showed a crash instead of what was wrong with the
file. It is an ordinary validation error now, which is what lets the reshaping
above run at all — recovery only happens after the validator has answered.

**Two rules keep recovery from finding the wrong thing.** Outside the spec
directory only the asked-for name is read — `tasks.json` at a project root is a
task-runner config far more often than it is a plan, and building somebody's
build config is a worse failure than the one this fixes. And a file found
outside the spec directory is *moved*, not copied: a second copy of the real
plan at the worktree root is worse than the truncated one `_cleanup_stray_root_plan`
removes, because a later read could pick it up.

The status bookkeeping the frontend keeps in `implementation_plan.json` before
the plan exists (`persistPlanStatusAndReasonSync` creates the file with
`status`, `xstateState`, `executionPhase` and no `phases`) is merged back over
the recovered plan. It describes the task, not the plan, and dropping it resets
a card that is visibly running.

### Requirement Traceability

`spec.md` names its requirements — `FR-001`, `NFR-001` — and every subtask in
`implementation_plan.json` claims the ones it implements:

```json
{ "id": "subtask-1-1", "requirements": ["FR-001", "FR-002"], ... }
```

Positions are not names. Numbering requirements `1.`, `2.`, `3.` meant inserting
one in the middle silently repointed every reference to the ones below it, so
nothing downstream referenced a requirement at all — and "which requirement is
covered by no subtask?" had no answer until QA read the finished branch.

`spec/traceability.py` is the single reader: `parse_requirements`,
`parse_open_questions`, `compute_coverage`. The parsing takes text, so the
validators, a workflow phase and a test all use it the same way.

Once the plan validates, `write_record` puts the answer in
`<spec_dir>/traceability.json` — requirements, open questions, and the coverage
map — and the coder loop prints the summary. That is the last moment a missing
requirement is cheap: the plan is valid, no code has been written against it,
and the fix is a sentence. The `analyze` phase, the Kanban and QA read that
record rather than each re-parsing `spec.md`; three parsers of one document is
how three answers to one question start.

**`[NEEDS CLARIFICATION: <question>]`** marks an assumption the inputs could not
settle. `spec_writer.md` used to be told to "make reasonable assumptions" full
stop, and in the finished document a guess reads exactly like a decision
somebody made. The marker keeps the two apart and makes the guesses countable.
It is not an escape hatch: a question the codebase or `context.json` answers is
work, not a clarification.

Both signals are **warnings, never errors**, in `validate_pkg`:

| Reported | Why not an error |
|---|---|
| open questions in `spec.md` | flagging what you do not know is the spec doing its job |
| no `FR-###` ids at all | specs written before ids existed are not broken |
| a requirement no subtask claims | it can be deliberately out of scope — the plan's author decides |
| a subtask referencing an undeclared id | the two documents drifted; which one is wrong is a judgement |

Coverage reports *not applicable* rather than 0% when the spec declares no ids —
a legacy spec scoring zero on every build teaches everyone to ignore the line.
And an error here would reach the validation auto-fix agent, whose cheapest way
to satisfy it is to bolt an id onto the nearest subtask: a signal that is always
green and always meaningless.

The quick path (`spec_quick.md`) takes the marker and skips the ids: identifiers
earn their keep when a plan has several subtasks to trace, and a quick spec
usually has one.

**In the Kanban.** `GET /api/spec-traceability/` (`spec/api.py`) answers the
same question at any moment, and `SpecTraceabilityCard` renders it in the task
panel — but only when there is something to say. A spec with nothing open and a
plan that claims everything renders nothing: a badge that is green 95% of the
time is a badge nobody reads. The endpoint **recomputes** rather than reading
back `traceability.json`, because the panel is opened most often on tasks that
have never been planned, where the file does not exist and the answer still has
to be right. Like `workflows/api.py`, it is refused in server mode — a client
naming a directory on a shared server is a cross-tenant read — so it is a
desktop feature until a `project_id`-addressed endpoint exists.

**Before the spec exists**, the clarification is already someone else's job:
`SpecInterviewBanner` asks 3-5 questions on a backlog task and appends the
answers as a `## Clarifications` section. Its prompt now sweeps nine coverage
areas (scope, data model, UX flow, non-functional, integrations, failure
handling, trade-offs, terminology, completion signals) and marks each Clear,
Partial or Missing before choosing what to ask — adapted from spec-kit's
`/speckit.clarify`. The sweep is not reported; it decides which five questions
get asked. Given a budget and no map, a model spends its questions on the area
the description already talks about most, because that is where it has the most
to say — so a spec that never mentions failure handling was never asked about
it.

### spec-kit projects

[spec-kit](https://github.com/github/spec-kit) (GitHub, MIT) is a
spec-driven-development toolkit, and a project initialised with it keeps its
binding rules in `.specify/memory/constitution.md`. WorkPilot builds other
people's projects; when one of them is a spec-kit project, those rules are the
house rules, and a plan written without them is one the project's own tooling
would reject.

`project/spec_kit.py` reads that one file, and `prompts.constitution_section`
is the single wrapper that hands it to everyone who needs it: the planner,
every coding subtask, the QA reviewer, and every skill phase the workflow runs.
There is nothing to install and nothing to configure — a project without
`.specify/` costs one `is_file()` call and produces no prompt section at all.

Those four readers are the point, not an afterthought. QA is the phase that
decides whether the result is acceptable, and `analyze` is asked outright what
the plan does that the project forbids; both were answering from conventions
they had inferred out of the codebase while the project had written its rules
down. A finding that cites the constitution is at least `HIGH`, because the
project wrote it precisely where inference was getting it wrong.

**Only the constitution.** spec-kit also keeps `specs/###-name/spec.md` and
`tasks.md` — its own equivalents of `spec.md` and `implementation_plan.json`.
Reading those would mean deciding which of two specs a build is following, and
that question has no good answer: WorkPilot has its own spec, written by its own
pipeline, for this task. The constitution is different because it is not about
this task at all — it is about the project, and it holds whichever spec is
driving the work.

The document goes in whole rather than as extracted rules: a `MUST` quoted out
of its section loses the scope that qualified it, and a sentence about what the
project *used* to require would be quoted as current law.

### Memory System (Graphiti)

Graph-based semantic memory in `integrations/graphiti/`. Configured through the Electron app's onboarding/settings UI (CLI users can alternatively set `GRAPHITI_ENABLED=true` in `.env-files/.env`). See [shared_docs/CONFIGURATION.md](../shared_docs/CONFIGURATION.md) for details.

### Skills System

Skills are markdown files with YAML frontmatter, following the [Agent Skills](https://agentskills.io)
open standard so the same file works across Claude Code, Copilot, Codex, Cursor and Gemini.

**Where they live:**

| Path | Role |
|---|---|
| `.agents/skills/<name>/SKILL.md` | The source read in production. Provider- and IDE-agnostic. |
| `.claude/skills/`, `.github/skills/`, `.cursor/skills/` | Per-harness mirrors |
| `.gemini/commands/*.toml` | Gemini CLI mirror |

A skill name is the output key — `.agents/skills/<name>/` — so two packs providing the
same name is a **collision**, not a merge. The resolver rejects the loser at the
`name-collision` gate with a reason naming the winner (`skills-cli why <skill>` prints
it), and the project decides: the pack listed first in `[packs]` wins. Several tracked
upstreams are adaptations of each other and share names on purpose, so leaving this to
iteration order meant the emitted content depended on alphabetical luck.

Those are **generated**. `skills/` is the source, and `scripts/skills_cli.py` is the only
thing that writes the outputs — `pnpm run skills:check` fails CI on drift. Packs are
added, updated and dropped through the same CLI (`skills:add`, `skills:update`,
`skills:remove`), which keeps `skills-lock.json`, `.workpilot/skills.toml` and the
`.gitignore` entries in step. See [skills/README.md](../skills/README.md).

`apps/backend/slash_commands/api.py` scans `.agents/skills/` and serves the result to the
Kanban Quick-Command bar (`GET /api/slash-commands`), then resolves a command's body
server-side so any provider can execute it.

**Reading frontmatter:** always through `skills_registry.frontmatter.parse_frontmatter`.
It parses with PyYAML and degrades to a line parser for hand-edited blocks. Do not write
another one — the repo used to carry four, with divergent semantics, and three of them
truncated any description ending in a quoted phrase.

WorkPilot-specific fields live under `metadata.workpilot` (pack, version, targets,
requires, min_effort, provenance) — a free-form space the Agent Skills spec reserves for
tooling and that Claude Code ignores.

**Python-side skills:** `apps/backend/skills/` holds two executable skills (`angular/`,
`migration/`) loaded by `skill_manager.py` with progressive disclosure — metadata first,
instructions on trigger, scripts on demand:

```python
from skills.skill_manager import SkillManager

manager = SkillManager("apps/backend/skills")
skill = manager.load_skill("framework-migration")
result = skill.execute_script("analyze_stack.py", {"project-root": "/path/to/project"})
```

### hermes-agent

[hermes-agent](https://github.com/NousResearch/hermes-agent) (Nous Research, MIT) is
supported, and the integration is deliberately small — because most of it already
existed.

**As a harness, nothing is emitted.** Hermes scans `<project>/.hermes/skills/` *and*
`<project>/.agents/skills/` at the git root, and injects `AGENTS.md`. Both are already
built and committed here, so `capabilities/harnesses.yaml` points its entry at the
agnostic path. A `.hermes/` mirror would duplicate ~390 files to say the same thing
twice and put `skills:check` in charge of policing two copies.

What it does need is one command in the checkout:

```bash
hermes skills trust
```

That is hermes's own trust gate, and it is right: project skills are load-on-demand
procedures an agent will follow, so auto-sourcing them from any cloned repo is a
prompt-injection vector. It is a per-machine decision by a person; nothing in this repo
makes it.

**Not in `providers.yaml`.** Hermes is an agent runtime, not an LLM provider — its own
loop, tools and model routing. Listing it there would claim WorkPilot can drive a task
on it.

**As a pack, `skills/hermes` is opt-in and scoped.** hermes-agent is a product that
ships skills, not a skill collection: hundreds of them, covering smart-home and
social-media alongside software development. `skills:bootstrap --pack hermes` takes
three categories and excludes the skills another tracked pack already provides —
`test-driven-development` is upstream's own adaptation of `obra/superpowers`. What is
left is what it genuinely adds: `systematic-debugging`, `spike`, the two runtime
debuggers, `merge-reconciler`, `sdlc-review`, and the procedures for driving Claude
Code, Codex and OpenCode.

**As a proposer, its learning loop feeds ours.** Hermes writes skills from its own
experience, on surfaces WorkPilot never sees — Telegram, Discord, a cron job on a VPS.
Two closed loops writing skills is one too many, so there is no second loop here:
`learning_loop/hermes_ingest.py` files each authored skill as a *candidate* under
`skills/_proposed/`.

**Only what hermes says it authored.** `skill_manage` writes `created_by: agent` into
`~/.hermes/skills/.usage.json` for a skill the agent wrote, and nothing of the sort for
one that was shipped or downloaded — so that record is the rule, and the shipped
(`.bundled_manifest`) and hub (`.hub/lock.json`) lists subtract on top of it. The
approval queue `pending/skills/` is admitted unfiltered: a skill is in it only because
the agent just wrote it, and its record is written on approval.

It started the other way round — everything except `.bundled_manifest` — and that shape
fails open twice over. It is a denylist against a catalogue upstream keeps growing, and
the manifest is `name:hash` per line, not JSON, so reading it with `json.loads` raised on
every line, the exception was swallowed, and the exclusion matched nothing. One build
proposed sixty upstream skills, `airtable` and `imessage` among them. The test that was
supposed to catch it wrote the manifest as JSON: it encoded our idea of the format
instead of the format. A denylist that fails open floods the queue; an allowlist that
fails closed proposes nothing, which a person notices and nothing is harmed by.

**And only what this repository has a use for.** The rule above reads files
*upstream* owns, which is right for the question it answers — what did hermes
write? — and is the one property that keeps failing. It failed by parsing
`.bundled_manifest` as JSON; it failed again on an install whose `.usage.json`
claims authorship over the shipped catalogue and which ships no manifest to
subtract. Both times the symptom was identical: sixty-one candidates, `airtable`
and `imessage` among them, and a person asked to delete them one by one. A third
fix to the reading of upstream's files would be the third version of the same
mistake.

`learning_loop/hermes_triage.py` is a **second authority**, and its inputs are
facts this repository owns:

| Read from | Answers |
|---|---|
| `skills/hermes/pack.json` (`--subdir`) | which of hermes's categories this project tracks |
| the same file (`--exclude`) | which names it looked at and turned down |
| `skills/<pack>/`, `skills-lock.json`, `.agents/skills/` | which skills it already provides |

The two authorities fail in opposite directions — hermes's bookkeeping fails
open, because an absent file excludes nothing; the scope fails closed, because an
unreadable `pack.json` leaves the declared default and an unknown category is out
of scope — so a flood now needs both to fail at once, and the second one cannot
fail by upstream shipping a release. Four reasons, all reported rather than
merely applied (`DROP_REASONS`): `already-provided`, `declined-here`,
`out-of-scope`, `upstream-catalogue`.

The last one is the rule for a hermes home kept flat, where there is no category
directory to compare against — which is the shape the sixty-one arrived in. It
reads the frontmatter: hermes's own authoring standard requires `author` and
`license` of a skill contributed to its repository, and requires neither of a
skill `skill_manage(action='create')` writes from a session's experience. A
locally authored skill carrying both is turned away, and that is the error worth
making — one skill nobody had yet, against sixty files nobody wanted. The
exception is hermes's approval queue: a skill is in `pending/skills/` only
because the agent just wrote it, so the fingerprint is not asked of it. That is
the one input whose provenance is not a record that can fail open, and silencing
it would cost the loop its best source.

**A rule that changed reaches the files the old rule produced.** Every cycle
withdraws the queued candidates a fresh verdict turns away, before it looks at
what hermes has — sixty files filed under a broken rule are one bug, not sixty
decisions somebody took, and the alternative is charging their owner for it. Only
files the ingest itself wrote are eligible (`recorded_facts` returns nothing for
anything else, so the learning loop's own evidence-carrying proposals are never
touched), and a legacy candidate that recorded neither its category nor its shape
is re-derived from the source path it does record. `GET /api/hermes/status` and
the Kanban card therefore report *what is left to read*, not what is on disk:
stale candidates are a number, not sixty rows, and the read does not delete them
— the next cycle does.

What triage does **not** move is the gate. A candidate that passes it still
carries no evidence from a build that used it, so it is filed and promoted by
nothing; `skill_proposer.evaluate` still refuses to invent corroboration. The
autonomy added here is over the chore, not over the decision.

**And the last chore goes too: `learning_loop/hermes_adopt.py` writes what
survives triage into `skills/hermes-learned/`.** The step it replaces was pure
transcription — open the candidate, copy the body into `skills/<pack>/`, delete
the candidate — and a queue whose only exit is a copy-paste is a queue that
fills up.

What makes that safe is not that the prose is trusted. `.workpilot/skills.toml`
is a want-list: `resolver.resolve` rejects every skill of a pack the project has
not listed, at the `pack-pin` gate. That pack is deliberately **not** listed, so
nothing in it is emitted to `.agents/skills/` or to any harness, and no agent can
load one. Auto-adoption writes agent-authored prose into the repository; it does
not make any agent follow it. The act that would — one line in `[packs]` — stays
with a person, is taken once rather than per skill, with the whole pack in front
of them, and is the moment to do the portability rewrite each file describes
(`adopted: verbatim` and the tool table say so in the file). Until then the
adopted file is an ordinary diff in the pull request of the task that adopted it,
reviewed like everything else here rather than in a queue that exists on one
machine — which is also why it is committed while `skills/_proposed/hermes--*.md`
is ignored.

**Adoption is one-way, and once.** Nothing deletes from the pack and nothing
rewrites a file already there, because the two things a person does with one are
the two things a loop must not undo: rewriting it (the portability pass — a
refresh from hermes would throw that away on the next build) and deleting it,
which is how you say no. `ADOPTED.json` records every name ever adopted, so a
deleted one is never re-adopted; without it the person deletes it again on every
build, for ever.

The queue keeps its copy, and that is deliberate: `skills/_proposed/hermes--x.md`
is the live mirror of what hermes has on *this* machine, refreshed when hermes
edits its own skill, while the adopted file is the snapshot the project took.
`queue_state` leaves a settled name out of what it reports, so nobody is asked
about it twice. And `hermes-learned` is the one pack `hermes_triage` does not
count as "already provided" — the others are decisions a person took about a
name, that one is the loop's own output, and counting it would have the loop mask
its own inputs one build later.

| Variable | Default | What it does |
|---|---|---|
| `HERMES_AUTO_ADOPT` | `true` | Adopt what survives triage. Off leaves the review queue as the only destination. On by default because the pack reaches no harness: the cost of being wrong is one file in one diff |

```bash
python3 scripts/skills_cli.py hermes-ingest --dry-run
python3 runners/hermes_runner.py --action status
python3 runners/hermes_runner.py --action cycle --surface kanban
```

#### The cycle, and who may open it

`apps/backend/hermes/` is the capability; the ingest above stays in `learning_loop/`
because that is where the review queue and its rules live.

| Module | Answers |
|---|---|
| `home.py` | where hermes keeps its state, and what the user configured there |
| `soul.py` | the persona this repository offers, and whether it is installed |
| `readiness.py` | whether the loop can run in this checkout, and what is missing |
| `loop.py` | the cycle itself, opened by a named feature surface |
| `api.py` | `GET /api/hermes/status`, `POST /api/hermes/cycle`, `POST /api/hermes/soul/install` |

The three steps that always go together — *can this run here*, *what did hermes
author*, *who asked* — are one function, and a **surface** is a name rather than a code
path: `build` (the `observe` phase), `kanban` (the task panel), `cli`, `self-healing`
(the end of an incident cycle, in `incident_responder/orchestrator.py`'s healing
pipeline — in a `finally`, because a pipeline that failed is not a reason to skip the
question, and reporting a step only when it filed something, since a "0 proposed" row on
every incident is a row nobody reads), `github`. `SURFACES` is a closed set on purpose, because the surface is written into a
file a person reviews and a free-text field would fill with whatever string each caller
happened to pass. The next feature to want the loop adds a line there, not a second
ingest.

The surface is recorded on the candidate, which is what lets a reviewer reading
`skills/_proposed/` six weeks later tell a build's observation from a person pressing a
button. That is the difference between a queue and a pile.

**The doctor runs before the phase, not after the empty result.** Five conditions —
`install`, `soul`, `trust`, `skills`, `agents` — all answerable from files on disk in
milliseconds, which is why the Kanban can ask on every panel open. Only `install` is a
blocker; the rest degrade, because a candidate hermes authored *elsewhere* is exactly
the experience from outside this repository that makes the integration worth having.
The failure this exists to prevent is the silent one: `trust` is unset on every fresh
clone, hermes then loads no project skills, nothing appears, and the conclusion drawn
six weeks later is "hermes doesn't work here".

**There is no endpoint that grants trust.** `status` reports whether this checkout is
listed in `skills.trusted_project_dirs` and returns the exact command that fixes it, and
that is where it stops. Trusting a checkout makes every `SKILL.md` in it a procedure
hermes will follow in every session on the machine — the prompt-injection vector the
gate was built to close. Software that grants itself the trust has removed the gate.

**In the Kanban.** `HermesLearningCard` in the task panel shows the five conditions with
their remedies, the candidates already waiting, and a button that turns the cycle now.
It renders nothing when hermes is not installed: a permanent card reading "feature not in
use" is a card nobody reads. Like `workflows/api.py`, the router is refused in server
mode — every answer is about `$HERMES_HOME` on the machine running the backend, which on
a shared deployment belongs to the server and not to the tenant asking.

#### Portability of a candidate

The cycle itself runs on any provider — every answer comes from files on disk, and
`TestProviderIndependence` fails the build if `hermes/` ever names `create_client`,
`anthropic` or `claude_agent_sdk`. What is *not* portable is the candidate's prose.

Hermes's authoring standard requires a skill to say `read_file` and not cat,
`search_files` and not grep, `patch` and not sed. That is right for hermes and wrong
everywhere else: `skills/<pack>/` is emitted to Claude Code, Copilot, Codex, Cursor and
Gemini alike, none of which have those tools. So each candidate carries a **Portability**
section naming the hermes tools it uses and their equivalents here, and the body is left
exactly as hermes wrote it — a find-and-replace would leave the surrounding sentence
("invoke through the `terminal` tool") describing a tool it no longer names. Adopting a
candidate is a rewrite, and the candidate says so rather than letting whoever runs the
adopted skill first discover it.

The same vocabulary is recorded in `capabilities/harnesses.yaml` under `hermes.tools`.
Nothing reads it today — `agents_path` is null, and `translate_tools` fires only when an
agent definition is emitted — but an empty map claimed "nothing to translate", which was
wrong in the one direction that matters: the day hermes gets an agents path, an empty map
emits Claude's names verbatim.

#### `SOUL.md`

`SOUL.md` at the root of this repository is the persona WorkPilot offers, and it is
**not a project context file**. `agent/prompt_builder.load_soul_md` reads exactly one
path — `<HERMES_HOME>/SOUL.md` — and injects it as identity slot #1 of every hermes
session on every surface. Project context is a different chain entirely (`.hermes.md` /
`HERMES.md` → `AGENTS.md` → `CLAUDE.md` → `.cursorrules`, first found wins), and this
repository is already answered by its committed `AGENTS.md`.

Shipping one anyway is right for the reason hermes ships one at the root of its own
repository: it is the persona a person installs, and a persona nobody can see is a
persona nobody adopts. The file is the offer; the install is a separate, explicit act —
from the card's button or `--action install-soul`, never from a build. That home belongs
to the user's own agent, in conversations WorkPilot will never see; a pipeline that
silently overwrote it would be rewriting a personality that is not ours. A *different*
persona already in place is left alone unless the caller says otherwise, and the one it
replaces is kept beside it with a timestamp.

A candidate carries **no external verification signal**, and that is not a gap to close
later. Hermes's approval gate is a person saying yes to a text; it is not an observation
of a build that used the skill. Counting it as corroboration would manufacture exactly
the evidence `skill_proposer.evaluate` refuses to invent. Hermes proposes from breadth,
WorkPilot decides from evidence, and a person reads one diff. Nothing under
`skills/<pack>/` is modified, and nothing under `~/.hermes` is ever written.

### Le cerveau partagé (Obsidian + Graphify + MCP)

Chaque agent a sa mémoire — `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, le
`MEMORY.md` de hermes, le workspace d'OpenClaw — et aucun ne lit celle des
autres. Une préférence dite à Claude Code un lundi est inconnue de Codex le
mardi. `apps/backend/brain/` est **un seul cerveau que tous les agents lisent et
écrivent, et qu'aucun ne possède** : un vault Obsidian, un `graph.json` au
format Graphify, un dépôt git synchronisé, servi par un serveur MCP.

```
<cerveau>/                       Réglages → Cerveau partagé, WORKPILOT_BRAIN_DIR, sinon ~/.workpilot/brain
  instructions/<slug>.md         une instruction partagée par note — `agents:` dit qui la suit
  knowledge/<slug>.md            décisions, faits, emplacements
  knowledge/projects/<p>/builds/ une note par tâche du Kanban, et ce qu'on y a appris
  agents/<agent>/…               instantanés des mémoires propres à chaque agent
  skills/graph-first-recall/     le skill de rappel graph-first, semé à l'init
  .workpilot-brain/brain.json    le marqueur : ce dossier est un cerveau (versionné)
  .workpilot-brain/INSTRUCTIONS.md  condensé généré (ignoré par git)
  graphify-out/graph.json        le graphe, reconstruit à chaque écriture (ignoré par git)
```

| Module | Répond à |
|---|---|
| `graph.py` | le `graph.json` au format node-link de Graphify, construit depuis les notes, et ses requêtes (`query`, `get_node`, `shortest_path`) |
| `sync.py` | commit → pull (rebase, puis merge) → push ; conflit = les deux versions gardées |
| `agents.py` | **la** table : où chaque agent garde sa mémoire et déclare ses serveurs MCP |
| `memories.py` | mémoire d'agent → cerveau (`ingest`), cerveau → mémoire d'agent (`bridge`) |
| `connect.py` | inscrire `workpilot-brain` dans la configuration MCP de chaque agent |
| `mcp_server.py` | le serveur MCP stdio |
| `vault.py` | `Brain`, le seul objet qu'appellent MCP, CLI et HTTP |
| `runtime.py` | le branchement sur **toutes** les features de WorkPilot |
| `learn.py` | ce que WorkPilot enregistre lui-même : chaque build, chaque merge |

```bash
python apps/backend/runners/brain_runner.py --action init --remote git@github.com:moi/brain.git
python apps/backend/runners/brain_runner.py --action ingest --project-dir .   # importe les mémoires existantes
python apps/backend/runners/brain_runner.py --action connect                  # aperçu ; --apply pour écrire
python apps/backend/runners/brain_runner.py --action bridge  --apply
python apps/backend/runners/brain_runner.py --action watch                    # pendant qu'on édite dans Obsidian
```

**Le graphe est celui de Graphify, pas un format voisin.** Nœuds `id`, `label`,
`file_type`, `source_file`, `metadata` ; liens `source`, `target`. C'est ce qui
fait que le skill `graph-first-recall`, le serveur MCP de Graphify et tout
lecteur node-link fonctionnent sur le cerveau sans adaptation — et les outils
MCP `query_graph`, `get_node`, `shortest_path` portent les noms de ceux de
Graphify pour la même raison. Un `graph.json` que Graphify a écrit dans le même
fichier survit à la reconstruction : nos nœuds portent
`metadata.origin = "workpilot-brain"`, et seuls ceux-là sont remplacés.

**Le rappel descend une échelle.** `brain_recall` répond aux niveaux 1 et 2 —
les nœuds, leurs voisins, leur frontmatter — et `brain_read_note` au niveau 3,
dans un appel séparé : décider quel fichier mérite d'être ouvert est tout
l'intérêt des deux premiers.

**Chaque modification est poussée, chaque lecture est précédée d'un pull.**
`Brain.write` finit toujours pareil — graphe reconstruit, condensé réécrit,
ponts rafraîchis, commit, pull, push — et `before_read` tire le distant quand la
copie locale a plus de `BRAIN_PULL_INTERVAL` secondes. Le commit *précède* le
pull : ce qu'une personne a tapé dans Obsidian part avec la prochaine lecture
d'un agent, et `--action watch` le fait sans attendre d'agent. Le graphe et le
condensé sont dérivés, donc ignorés par git et reconstruits après chaque pull :
committés, deux machines ajoutant chacune une note seraient en conflit sur
`graph.json` à chaque synchronisation.

**Un conflit ne perd rien.** Une note par fichier rend les conflits rares ;
quand deux agents touchent la même note, le rebase est tenté, puis le merge, et
si les mêmes lignes divergent encore, la nôtre reste en place et la leur est
écrite à côté (`<nom>.conflict-<sha>.md`). Choisir un gagnant en silence serait
décider à la place de la personne lequel des deux agents avait raison. Les
chemins en conflit sont lus avec `-z` : en sortie ligne, git met entre
guillemets et échappe en octal un nom non ASCII (`"Id\303\251es.md"`), et une
note française partait sur GitHub avec ses marqueurs `<<<<<<<` dedans.

**La branche suivie est celle du distant.** Un cerveau créé ici sur `main` et
branché sur un vault gardé sur `master` suit `master` (`_remote_branch`) : il
tirait le distant pour vide et poussait une seconde branche à côté du vault.

**Similaire n'est pas doublon, et aucune des deux n'est perdue.** `remember`
cherche une instruction proche (mots à cinq lettres près, ou ratio de
caractères, seuil `BRAIN_SIMILARITY`) : trouvée, l'agent y est ajouté et sa
formulation est gardée sous la note ; sinon une note est créée. C'est ainsi que
le cerveau apprend qu'une instruction est *partagée*.

**Le pont s'ajoute à la mémoire de l'agent, il ne la remplace pas.** `bridge`
écrit un bloc délimité (`<!-- workpilot-brain:start -->`) dans le fichier de
mémoire global de l'agent : comment utiliser le cerveau, les instructions à
appliquer **en plus** des siennes, et celles qu'il suit déjà et que d'autres
agents partagent — une instruction similaire se lit comme une confirmation, pas
comme une seconde règle. Claude Code et Gemini importent le condensé par
`@chemin` ; les autres reçoivent la liste en ligne ; hermes, qui plafonne son
`MEMORY.md`, reçoit un pointeur et lit le reste en MCP. Le bloc est retiré avant
toute lecture d'instructions : sans cela, chaque `ingest` réimporterait le
cerveau dans lui-même, crédité à l'agent qu'on venait de brancher. Une
synchronisation ne rafraîchit que les fichiers qui portent déjà le bloc.

**Les fichiers des autres ne sont écrits que sur demande.** `connect` et
`bridge` affichent un aperçu ; `--apply` écrit, après une sauvegarde unique
(`*.workpilot-brain.bak`). Un JSON illisible n'est jamais réécrit ; un
`mcp_servers:` hermes déjà présent, ni une entrée Codex non gérée, non plus — le
fragment est rendu à la personne. TOML et YAML sont écrits en bloc délimité et
non par aller-retour de parseur, qui effacerait les commentaires d'un fichier
édité à la main. `connect_all --apply` n'installe rien chez un agent absent.
Pour Claude Code, la CLI `claude mcp add-json --scope user` est préférée à
l'édition de `~/.claude.json`, que Claude Code réécrit pendant qu'il tourne.

**Un secret n'est pas une connaissance.** Le cerveau a un distant : une ligne
qui ressemble à un identifiant est expurgée des instantanés et ne devient jamais
une instruction.

**Le serveur MCP n'a aucune dépendance.** Il est lancé par les agents *des
autres*, avec le Python qu'ils trouvent ; une dépendance absente là-bas est un
cerveau que personne ne joint. JSON-RPC 2.0 sur stdio, une ligne par message, et
le champ `instructions` d'`initialize` porte les règles d'usage : un agent jamais
branché par `bridge` les apprend en se connectant.

#### Brancher un vault Obsidian, un dépôt GitHub

Réglages → Intégrations → **Cerveau partagé** (`BrainSettings`, `GET/POST
/api/brain/settings`). Le choix est par personne, pas par projet, et vit dans
`~/.workpilot/brain.json` : les processus qui en ont besoin sont des processus
Python — lancés par l'application, par la CLI, par les agents des autres — et un
fichier est la seule chose qu'ils peuvent tous lire. `WORKPILOT_BRAIN_DIR` gagne
toujours, et le champ passe alors en lecture seule : un réglage qui ne gagne pas
ne doit pas avoir l'air de gagner.

`Brain.init` distingue trois cas, d'après ce qu'il y a sur le disque :

| Dossier | Ce qui se passe |
|---|---|
| absent ou vide, un distant donné | **cloné** — un cerveau d'une autre machine, ou un vault gardé sur GitHub |
| absent ou vide | un nouveau cerveau, avec son README et ses dossiers |
| tout le reste | **adopté** tel quel — un vault Obsidian que la personne a déjà |

**Un vault adopté ne voit rien apparaître à sa racine.** Le marqueur et le
condensé vivent dans `.workpilot-brain/`, qu'Obsidian ne liste pas ; pas de
README, pas de note générée. Ses notes deviennent celles du cerveau : le rappel
lit tout le vault, et c'est tout l'intérêt de le brancher. Un vault déjà sous git
(le plugin obsidian-git) garde son dépôt et son `.gitignore`, auquel on ajoute
seulement les lignes dont le cerveau a besoin. Un clone raté dit pourquoi au lieu
de laisser derrière lui un cerveau vide.

**Deux garde-fous, parce que l'API locale est joignable depuis un navigateur.**
Le dossier choisi reste sous le répertoire personnel : un endpoint qui crée un
dépôt git là où on le lui dit écrit dans `/etc` pour qui le demande. Et un
distant est un distant (`sync.normalize_remote`) : `utilisateur/dépôt` pour
GitHub, sinon https, ssh, `git@hôte:`, file ou un chemin. Une valeur qui commence
par `-` est une option pour `git clone` (`--upload-pack=…` lance un programme) et
`ext::` est un transport qui en lance un aussi ; les deux sont refusés avant que
git ne les voie, et les commandes passent `--` avant leurs arguments positionnels. Les
refus et les échecs reviennent sous forme de **codes** (`outside-home`,
`invalid-remote`, `auth`, `not-found`, `locked`, `identity`, `rejected`…) que
l'interface traduit, **et** avec les mots de git (`detail`, `_git_detail`) : le
code dit quel genre d'échec, le détail dit lequel, et c'est lui qu'on colle dans
un moteur de recherche. Une ligne, les trois premières de git, sans les
identifiants qu'une URL peut porter (`https://user:token@…`) ; le journal reçoit
la même ligne avec l'étape (`commit`, `fetch`, `pull`, `push`). Un message
« détails dans le journal » dont le journal ne contenait que le code n'aidait
personne. Et aucune exception imprévue ne sort en 500 : sans en-têtes CORS, le
renderer n'en lit que « Failed to fetch ».

**Le frontmatter est celui d'une personne.** `date: 2024-01-01` — notes
quotidiennes, propriétés Obsidian — est un objet `date` pour YAML ; une seule
note de ce genre rendait `graph.json` impossible à écrire. `graph._plain` ramène
chaque valeur à du JSON.

#### Ce que la tâche a appris, dans le Kanban

`BrainTaskCard`, dans le panneau de tâche (`GET /api/brain/task`). Le serveur MCP
lancé pour un build porte `WORKPILOT_BRAIN_TASK=<projet>/<spec>`, et l'exécuteur
d'outils des autres fournisseurs passe la même référence : chaque note et chaque
règle écrites pendant la tâche portent `tasks:` et un lien vers la note de build.
La carte lit le graphe, pas chaque fichier d'un gros vault, et ne tire pas le
distant : ouvrir un panneau n'est pas une raison d'attendre le réseau.

Elle ne s'affiche que quand le cerveau a quelque chose de cette tâche. Elle
montre la note de build (verdicts QA et tests, `acceptée` après un merge), les
notes apprises, et les **règles proposées**, qu'une personne active ou refuse sur
place : c'est devant la tâche qui l'a fait naître qu'on juge le mieux une règle.
« Ouvrir dans Obsidian » ouvre la note par son chemin (`obsidian://open?path=`),
d'où `obsidian:` dans les schémas qu'`open-external.ts` accepte — il ne lance que
l'application Obsidian, jamais un programme arbitraire.

#### Branché sur toutes les features

Aucune feature ne parle au cerveau d'elle-même. Planner, coder, QA, pipeline
de spec, insights, idéation, roadmap, runners GitHub/GitLab, self-healing :
chacune construit son agent par `create_client` et son prompt par
`build_base_system_prompt`, et les fournisseurs sans SDK Claude exécutent leurs
outils dans `tool_executor`. Ces trois points sont branchés une fois, comme rtk
et watermarks : une feature ajoutée le mois prochain est branchée parce
qu'elle a été écrite normalement.

| Où | Ce que le cerveau ajoute |
|---|---|
| `get_required_mcp_servers` + `create_client` | le serveur `workpilot-brain` et ses outils autorisés, pour **tout** agent qui a des outils (pas `commit_message` ni `merge_resolver`). Il n'est pas déclaré agent par agent dans `AGENT_CONFIGS` : une liste à tenir à jour, c'est la prochaine feature débranchée. `AGENT_MCP_<agent>_REMOVE=brain` le retire |
| `build_base_system_prompt` | `awareness_section` : rappel graph-first, apprendre en travaillant, et les instructions partagées **en plus** des règles de la tâche. Lue sur disque, jamais tirée du réseau, stable au byte près pour le cache de prompt |
| `tool_executor` | les mêmes outils pour Copilot, OpenAI, Gemini, Ollama…, exécutés dans le processus |

L'apprentissage a deux moitiés. Les agents écrivent quand ils remarquent
quelque chose (le prompt le leur demande) ; ça dépend d'un modèle qui le décide.
`learn.py` est l'autre moitié : ce que WorkPilot **sait**, enregistré qu'un
agent y ait pensé ou non.

| Surface | Moment | Note |
|---|---|---|
| `build` | fin de chaque build Kanban/CLI (`_record_build_in_brain`), à tout niveau d'effort, moteur de workflow ou non | `knowledge/projects/<projet>/builds/<spec>.md` : la demande, le verdict QA et tests (`non mesuré` n'est pas `vert`), les fichiers touchés |
| `merge` | un merge depuis le Kanban (`run.py --merge`) | la même note, `status: merged` : une personne a relu le diff et dit oui |
| les autres | `POST /api/brain/learn` avec une surface de `SURFACES` | `knowledge/projects/<projet>/<surface>/…` |

Chaque note de build pointe vers `knowledge/projects/<projet>/index.md`, si bien
qu'un seul `brain_recall` répond à « qu'a-t-on fait sur ce projet, et qu'est-ce
qui a été accepté », depuis n'importe quel agent. Le nom du projet est lu à
travers le worktree : sinon chaque tâche serait classée sous un « projet »
différent.

**Les agents de WorkPilot proposent des règles, une personne les active.** Une
instruction active est injectée dans le prompt de tous les agents, sur tous les
projets. Et un agent de build lit, dans la même session, des issues, des PR et
des pages web, qui peuvent toutes lui demander de « retenir » n'importe quoi. Le
serveur que WorkPilot lance pour ses propres agents porte donc
`WORKPILOT_BRAIN_ORIGIN=workpilot`, et l'exécuteur d'outils appelle le cerveau
en non fiable. Dans ce mode, un agent :

- écrit des connaissances (`knowledge/`), rappelées à la demande et lues comme
  des données ;
- **propose** des instructions (`status: proposed`), qui ne s'appliquent à
  personne tant qu'une personne ne les a pas activées ;
- ne touche ni à une instruction en vigueur, ni aux skills, ni aux instantanés
  de mémoire.

Les agents qu'une personne branche elle-même par `connect` (Claude Code,
Codex, hermes…) écrivent en son nom, sans cette restriction. Pour activer ou
refuser une proposition : `--action proposals`, puis `--action promote` ou
`--action reject` avec `--path` ; ou bien changer `status:` dans Obsidian.

**Actif seulement quand un cerveau existe.** `BRAIN_ENABLED` vaut `true` par
défaut ; sans cerveau sur disque, chaque point d'entrée répond en un `is_file`
et n'ajoute rien — pas de serveur lancé, pas de section de prompt, pas d'outil.
L'allumer, c'est lancer `--action init` : une décision de la personne sur
l'endroit où vit sa connaissance et le distant où elle est poussée.

| Variable | Défaut | Rôle |
|---|---|---|
| `WORKPILOT_BRAIN_DIR` | `~/.workpilot/brain` (`%APPDATA%\WorkPilot\brain`) | où est le cerveau |
| `BRAIN_ENABLED` | l'interrupteur des Réglages, sinon `true` | branche le cerveau sur toutes les features, quand il existe |
| `WORKPILOT_BRAIN_CONFIG` | `~/.workpilot/brain.json` | où les Réglages enregistrent le dossier et l'interrupteur |
| `BRAIN_PULL_INTERVAL` | `60` | secondes entre deux pulls avant lecture |
| `BRAIN_AUTO_PULL` / `BRAIN_AUTO_PUSH` | `true` | pull avant lecture / push après écriture |
| `BRAIN_SIMILARITY` | `0.72` | seuil au-delà duquel deux instructions n'en font qu'une |

`GET /api/brain/status`, `POST /api/brain/sync` et `POST /api/brain/recall`
exposent la même chose au desktop ; comme `hermes/api.py`, le routeur est refusé
en mode serveur — le cerveau vit dans le répertoire personnel de la machine qui
exécute le backend.

### Memory Search (`mem-search`)

Three-layer progressive retrieval over the memories that already exist — `task_logger`
traces and `learning_loop` patterns — so an agent can ask "have we hit this before?"
without paying for every candidate to discard most of them.

```python
from mem_search import search_for

memory = search_for(project_dir)
index = memory.index("flaky timeout in the integration suite")  # ~100 tokens, always
memory.timeline(index.ids()[:3])  # a couple of lines each
memory.detail("task:042-add-widget")  # the full record, by id
```

The index is held to a token budget by dropping entries and reporting the count, never
by truncating what it kept, and building it never reads a record body — a source that
loaded everything in order to list it would have moved the cost, not removed it.

The agent-facing side is `skills/tooling/mem-search/`. `claude-mem` is declared as an
**optional** pack (`pnpm run skills:bootstrap --pack claude-mem`) rather than installed:
its retrieval pattern is what was worth adopting, and taking the tool itself would add a
fourth memory with its own worker and two more stores.

### Where generated tests are written

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

### What generated tests are written against

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

### Library Documentation (`libdocs`)

Before every build, one question: *is there a library in this task that the repository
shows no example of?* When there is, its current documentation is downloaded from
Context7 and staged next to the spec, and the coder is told to read it before writing
code against that library.

```
apps/backend/libdocs/
  detect.py     which libraries this task needs, and which the repo already teaches
  context7.py   the REST client (`/v2/libs/search`, `/v2/context`)
  cache.py      .workpilot/docs-cache/, shared between specs, 14-day TTL
  preflight.py  runs the three, stages the pages, renders the prompt section
```

**The signal is usage evidence, not popularity.** A library imported in twenty files is
skipped deliberately — the codebase teaches it better, house conventions included. One
declared and imported nowhere, or named by the task and in no manifest at all, is the
case this exists for: there is nothing to copy, so the model writes the API it remembers.

A task that names no library at all falls back to the declared dependencies nothing
imports yet — but **only on a project under ~50 source files**. A mature repository has
examples of its own stack by definition, so guessing there would spend the budget on
whichever dependency sorts first.

**Why this and not just the MCP server.** Context7 stays declared for the coder, the
researcher and the reviewers, and mid-session `mcp__context7__query-docs` is exactly
right. The failure it cannot cover is the other one: the agent does not notice it should
ask. Reading manifests does not require the model to doubt itself.

**It never fails a build.** No network, no key, quota spent, library not indexed — the
result records why, one line is printed, and the session proceeds.

| Variable | Default | What it does |
|---|---|---|
| `CONTEXT7_API_KEY` | — | Raises the quota above the anonymous per-IP one. Also passed to the MCP server. Free key: context7.com/dashboard |
| `CONTEXT7_ENABLED` | `true` | Turns off the MCP server **and** the preflight — one decision about sending task text to Context7 |
| `LIBDOCS_ENABLED` | `true` | Turns off the preflight alone |
| `LIBDOCS_MAX_LIBRARIES` | `4` | Pages downloaded per build |
| `LIBDOCS_TTL_DAYS` | `14` | How long a cached page is served before it is fetched again |
| `CONTEXT7_API_URL` | `https://context7.com/api` | Self-hosted or proxied index. Read by the MCP server too |

All of them are read from `.workpilot/.env` as well as the environment, so the toggle
and key set in Settings → Agent Tools → MCP Servers reach the preflight and not only the
MCP server. Real environment variables win over the file.

**Note on the MCP tool names.** `@upstash/context7-mcp` renamed `get-library-docs` to
`query-docs` (`libraryId` + `query`, no `topic`/`mode`), and the server is started
unpinned, so both names are allowlisted — an entry for a tool the running server does
not expose is inert, a missing entry for the one it does expose is silent failure.

### Token savings (rtk)

[rtk](https://github.com/rtk-ai/rtk) (rtk-ai, Apache-2.0) is a CLI proxy: it
runs the command it was given and prints a filtered version of its output.
Same behaviour, same exit code, a fraction of the bytes — 9 879 bytes of
`ls -la apps/backend` become 1 059 in this checkout, and `git status` 232 into
66.

That is worth wiring in because of where WorkPilot's input budget actually
goes. The prompts are written once and cached; what is paid for on every turn
of every phase is the *output of the commands the agents run* — a test suite,
a build log, a directory listing, a diff. Nothing in this repository was
looking at that number.

```
apps/backend/rtk/
  runtime.py    is there an rtk here, is it new enough, what is missing
  settings.py   RTK_ENABLED / RTK_MODEL_FACING, environment and .workpilot/.env
  rewrite.py    what rtk would run instead — delegated to `rtk rewrite`
  hook.py       the PreToolUse hook every agent Bash call passes through
  prompt.py     the paragraph that stops a model re-running condensed output
  capture.py    WorkPilot's own commands, when their output goes into a prompt
  stats.py      what rtk has actually saved, from rtk's own ledger
  api.py        GET /api/rtk/status
```

**One change reaches every feature.** Planner, coder, QA reviewer and fixer,
the spec pipeline, ideation, the GitHub runners, the self-healing responder,
the architecture map, the mobile phases — none of them run a command of their
own. They all go through `core.client.create_client`, so registering
`rtk_rewrite_hook` there covers the lot, and a phase added next month is
covered by having been written the normal way. The providers that do not use
the Claude SDK execute their shell commands in
`core/runtimes/tool_executor.py`, which is the same rewrite in the other
half of the product.

**The rewrite table is not reimplemented.** `rtk rewrite <command>` is the
same registry rtk's own shell hooks consult, and it answers through its exit
code — 0 rewrite, 1 no equivalent, 2 denied, 3 rewrite behind an "ask" rule.
It is a hundred commands deep and it moves with every release; owning a second
copy of it in Python would mean two answers to one question, drifting apart
silently. One subprocess per Bash tool call is the price, against a tool call
that is about to run a test suite.

**The hook never decides permissions.** rtk's own shell hook returns
`permissionDecision: "allow"` next to the rewrite, which is right for a person
at a terminal and wrong here twice over: WorkPilot already grants `Bash(*)` in
its settings file and gates the real decision on `bash_security_hook` and the
guardrails. A third hook voting "allow" while only knowing about bytes is a
second opinion on a settled question. So the hook returns `updatedInput` and
nothing else — it changes what a command prints, never whether it runs. rtk's
own deny rules are treated the same way: the command is left alone and
WorkPilot's allowlist decides.

**The allowlist never sees the word `rtk`.** This is the one place the feature
could have weakened something. rtk falls back to raw execution for anything
its table does not cover (`run_fallback` in its `main.rs`), so `rtk <anything>`
runs `<anything>` — and a validator reading the command name as "rtk" and
stopping there would have turned one allowlisted word into a door to every
binary on the machine. `security/parser.unwrap_rtk_prefixes` rewrites each
segment back to what rtk will run before anything is judged, and
`get_command_for_validation` hands the deep validators the unwrapped segment
for the same reason: every one of them opens with `tokens[0] != "git"`, so
`rtk git commit` would have reached the repository without its secret scan.
`rtk` stays in the base command registry only for its own meta commands
(`rtk gain`, `rtk discover`), which proxy nothing.

**A model that is not told will re-run the command.** Given forty lines where
it expected four hundred, the reasonable thing for an agent to do is doubt the
result and try again — and two extra turns cost more than the filtering saved.
`rtk.prompt.awareness_section` is appended by `build_base_system_prompt`, so
every provider branch gets it, and it is empty on a machine without rtk: an
agent told its output is condensed when it is not will second-guess perfectly
complete results. The text carries no version, path or count, because it sits
in the cacheable prompt prefix.

**rtk is for output a model reads, never for output code parses.** That is why
`core.git_executable.run_git` is deliberately untouched and there is no global
switch: `git status --porcelain` feeds a parser, `git diff --numstat` feeds a
counter, and condensing either saves nothing — none of it is ever sent to a
model — while breaking the caller. A call site opts in by calling
`rtk.capture_for_model`, which is a statement about where its output is going.
`agents/self_review.py` is the example to copy: three git calls, and only the
`git diff HEAD` excerpt that reaches the model goes through rtk. The test
runners in `qa/auto_fix_loop.py` and `self_healing/incident_responder/
cicd_mode.py` are the counter-example and stay raw, because their output feeds
`_parse_test_counts` and `_parse_failing_tests` before it feeds a prompt.

**Nothing here can fail a build.** rtk absent, too old, turned off, timing
out, crashing, printing something unexpected: the command runs exactly as
written. The worst the integration can do is cost a session two seconds.

| Variable | Default | What it does |
|---|---|---|
| `RTK_ENABLED` | `true` | The master switch. "On" costs nothing without rtk — every entry point answers in a cached `shutil.which` |
| `RTK_MODEL_FACING` | `true` | Whether WorkPilot's *own* captures are condensed too. Separate because it changes what a code path receives, not only what a model reads |
| `WORKPILOT_RTK_PATH` | — | A specific binary, for a build that is not on PATH and for tests |
| `RTK_DISABLED` | — | rtk's own escape hatch, honoured rather than rewritten into a no-op |

Both switches are read from `.workpilot/.env` as well as the environment, so
Settings → Agent Tools → Token savings reaches the hook, the awareness
paragraph and the captures from one place. Real environment variables win.

**In the UI.** `RtkSavingsCard` in the task panel reports the conditions and
what rtk has recorded for this project, and renders nothing at all when rtk is
not installed — a permanent card reading "feature not in use" is a card nobody
reads. Discovery happens in Settings instead, which is where one goes to look
for what could be switched on. Neither surface has an install button:
`rtk init -g` writes a hook into the user's own Claude Code settings, for every
session on the machine and not only the ones WorkPilot drives, so — like the
hermes trust gate — the panel prints the command and the person types it.

The savings figure is reported as what was measured and nothing more. rtk
ships no tokenizer and estimates tokens as bytes / 4; shell output is one input
among prompts, history and system instructions, which are themselves the input
half of a bill that also pays for output. The extrapolation is made by nobody.

**How it is verified.** The layers split by what they need, the same way the
mobile toolchain does:

| Layer | Proven by | Where |
|---|---|---|
| the exit-code protocol, the hook, the failure paths | a fake rtk that answers a chosen code | `tests/test_rtk_rewrite.py` |
| the allowlist seeing through the proxy | the real parser and the real validators | `tests/test_rtk_security.py` |
| the capture rule, and self-review honouring it | a fake rtk, and the module's own source | `tests/test_rtk_capture.py` |
| that rtk still behaves the way this integration assumes | whatever rtk is really installed | `tests/test_rtk_contract.py` |

The last row exists because every assertion in the first three is fed a string
somebody here wrote: they test our idea of rtk. The contract tests assert what
must hold *whatever* version is installed — that `rtk rewrite` answers with one
of its four codes, that a rewrite is a command line, that the exit code
survives, and that a command rtk rewrote still names itself to the allowlist —
and never that a particular command is condensable, because rtk's table grows
and shrinks and a test pinning one entry of it gets disabled within a month.
They skip when rtk is not installed.

### Clean generated files (watermarks)

[watermarks-remover](https://github.com/guillaumemeyer/watermarks-remover)
(Guillaume Meyer, MIT) removes provenance marks from content you own. Most of it
is about images, PDFs and audio; one part of it is about text, and that part
answers a question this repository had never asked: **what invisible characters
are in the files the agents write?**

Zero-width spaces, exotic spaces, bidirectional controls and tag characters are
how a statistical or vendor watermark rides in model output. In prose they are
harmless and invisible. In a source file they are a `SyntaxError` nobody can
see, an identifier that does not match itself, a `grep` that finds nothing, and
a diff full of changes no one made — and they survive every copy-paste into a
repository. Generated code is the case where the cost is highest and the
detection is hardest.

```
apps/backend/vendor/watermarks/  the pinned upstream table (scripts/vendor_watermarks.py)
apps/backend/watermarks/
  runtime.py   is the vendored table loadable, and is the tree its receipt's one
  settings.py  has the user turned it on, and how aggressive may it be
  clean.py     text on its way to disk -> clean text, and what changed
  hook.py      the PreToolUse hook every agent Write and Edit passes through
  ledger.py    <spec_dir>/watermarks.jsonl — the record of every silent edit
  api.py       GET /api/watermarks/status
```

**One file is vendored, not fifty.** `service/scripts/text_unicode.py` is Layer
A: the decision table that says which invisible codepoint is a carrier and which
is load-bearing — a ZWJ inside an emoji sequence, a joiner between two Arabic
letters, a filler after a Hangul jamo. 25 KB, stdlib-only, importing nothing
from its siblings, which `test_watermarks_vendor.py` asserts by parsing it
rather than importing it. The rest of upstream has no consumer here: the image
and container metadata strippers are for files a coding agent does not write,
and Layer B removes statistical marks by **paraphrasing** — a build that
silently reworded the code it just wrote would be a different product.

Committed rather than bootstrapped like the packs under `skills/`, for the same
reason as archify and a sharper one: this runs on every file of every build, so
a cleaner that works only where somebody ran an install command produces output
nobody can rely on. And the table is **never reimplemented** — same rule as
`rtk.rewrite` delegating to `rtk rewrite`. Two copies of a Unicode policy is two
answers to one question, and this one is subtle enough that the second copy gets
the preservation rules wrong long before anyone notices.

**One change reaches every feature.** Planner, coder, QA fixer, the spec
pipeline, the GitHub runners, the mobile phases — none of them write a file of
their own, they all go through `core.client.create_client`, so the hook is
registered there once. The providers that do not use the Claude SDK execute
their writes in `core/runtimes/tool_executor.py`, which is the same cleaning in
the other half of the product, exactly where `rtk_rewrite` already sits — and
the same *record*, which took longer to be true than the cleaning did. Not one
of those clients passed a spec directory down to the executor, so
`ToolExecutor.spec_dir` was always `None` and the ledger below was never written
on a non-Claude build: the bytes were edited and the one file that says so did
not exist. `create_agent_client` hands each client its `spec_dir` now, and
`test_watermarks_hook.py` fails on a `ToolExecutor(...)` built without one —
the cleaning is visible in the file, the record is the only evidence of what was
taken out of it, and a call site that forgets it loses that silently.

**`Pre`, not `Post`, and that is the whole design.** A PostToolUse hook would
read the file back, rewrite it, and leave a second mtime behind: a dev server
reloading twice, a watcher firing twice, and a window where the dirty bytes are
on disk and a test runner can read them. Rewriting `updatedInput` means those
bytes never exist.

**`old_string` is never touched.** `Edit` finds its target by matching that
field against the file *as it is on disk*, and a file that already carries an
invisible character carries it in the match too. Cleaning the needle is how a
working edit turns into "string not found" — and nothing is lost by leaving it
alone, because `new_string` is what lands.

**It never decides whether the write happens.** Like `rtk_rewrite_hook`, it
returns `updatedInput` and nothing else. The guardrails hook registered on the
same tools answers the permission question; a second hook that only knows about
invisible codepoints must not get a vote on it.

**Two of upstream's defaults are inverted, and two of its knobs are unreachable.**

| Option | Here | Why |
|---|---|---|
| `normalize_spaces` | **off** (upstream: on) | U+00A0 is load-bearing in the two languages this product ships: French typography puts one before `?`, `!`, `:`, and `fr/*.json` is full of them. Rewriting those loses a decision a translator made |
| `strip_bidi` | **off**, switchable | A paired RLE/PDF run is how Arabic and Hebrew are written. Turning it on is the Trojan Source hardening (CVE-2021-42574), where the attack *is* a well-formed embedding — worth having, worth being a decision. Unpaired and out-of-context controls go either way |
| `nfkc` | **not offered** | Folds `ﬁ` to `fi` and `４` to `4`. In a paragraph that is tidying; in a string literal, a regex class or a test fixture it is a silent behaviour change, and the file still compiles |
| `aggressive_homoglyphs` | **not offered** | Rewrites Cyrillic `а` to Latin `a`. A homoglyph in an identifier is worth catching — that is `injection_guard`'s catch, with a finding somebody reads — not something to fix by editing a Russian translation into nonsense on the way to disk |

**The model is not told, and that is not the same as nobody being told.** rtk
gets an awareness paragraph because a model handed forty lines where it expected
four hundred will doubt the result and run the command again. Here the change is
invisible by definition: a warning would describe something the model cannot
observe, and the only thing it could do with one is second-guess correct output.
But this is the one place in a build where WorkPilot edits bytes a model wrote
without saying so, so every change appends a line to
`<spec_dir>/watermarks.jsonl` — the file, the tool, the codepoints by name. A
reviewer asking why a line differs from what the transcript shows has the answer
next to the plan and the QA report.

**Nothing here can fail a build.** No vendored tree, a switch turned off,
content above the cap, upstream raising: the content is written exactly as the
model produced it and the reason is recorded rather than hidden. The cost on a
file with nothing to strip is a single `str.isascii()` — every codepoint the
table can touch is non-ASCII, and
`test_watermarks_vendor.py::test_no_ascii_codepoint_is_ever_touched` checks all
128 of them, because that is upstream's property to keep and not ours to assume.
The day a release breaks it, the fast path would skip exactly the files that
needed the work, silently, on every build.

| Variable | Default | What it does |
|---|---|---|
| `WATERMARKS_ENABLED` | `true` | The master switch. The only way to turn the feature off |
| `WATERMARKS_NORMALIZE_SPACES` | `false` | Rewrite U+00A0 and its fifteen siblings to a plain space |
| `WATERMARKS_STRIP_BIDI` | `false` | Strip well-formed bidi embeddings too — the Trojan Source hardening |
| `WATERMARKS_MAX_BYTES` | `1048576` | Above this the content is passed through and the skip is reported. A nonsense value falls back to the default rather than disabling anything through a knob documented as a size |

All of them are read from `.workpilot/.env` as well as the environment, so what
Settings writes reaches the hook, the tool executor and the status endpoint from
one place. Real environment variables win.

**How it is verified.** The layers split by what they need, the same way rtk's
do:

| Layer | Proven by | Where |
|---|---|---|
| the settings, the skips, the cap, the failure paths | our own wrapper | `tests/test_watermarks_clean.py` |
| what the hook rewrites, and the `old_string` it refuses to | fabricated tool calls | `tests/test_watermarks_hook.py` |
| that the table still behaves the way this integration assumes | the vendored tree itself | `tests/test_watermarks_vendor.py` |

The last row is the one that matters when somebody moves the pin
(`python3 scripts/vendor_watermarks.py --ref …`). It asserts what must hold of
*any* version — self-contained, the API driven here, no ASCII codepoint touched,
a ZWSP removed and the joiners kept — and never that one exotic codepoint has
one particular fate, because upstream's table grows with every release and a
test pinning one entry of it gets deleted within a month.

### Architecture diagrams (archify)

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
context, at `min_effort: medium`. Two filters gate it, and it needs both:
`when: touches(...)` is a glob and can only say "a `.ts` changed", which is most
tasks, so `significance.assess` decides inside the phase, from paths alone and
before any API call, whether the changed files touch a modelled component's
sources or draw an area the model does not describe yet. Under the threshold the
phase records "no architectural change" and returns for zero tokens — the same
shape as `docs` and its libdocs preflight.

The record lands in `<spec_dir>/architecture/` — the spec directory, not the
worktree, because the worktree is removed at merge and "what did this task
change" is asked after the merge. `TaskArchitectureDelta` renders the counts and
the Before/Delta/After, and **renders nothing at all** for `not-significant` or a
mapped delta whose counters are zero; `shouldShowArchitectureDelta` gates the tab
trigger on the same predicate, so those states never produce a tab. A tab that
reads "no change" on most tasks is a tab people stop opening.

| Variable | Default | What it does |
|---|---|---|
| `WORKPILOT_ARCHIFY_HOME` | — | Point at a clone instead of the vendored tree, for moving the pin without touching `vendor/` |

### Mobile applications (Android and Apple)

A phone application breaks the assumption every other part of this repository
makes about a project: that it can be *run*. There is no dev server and no
localhost URL. The artefact is compiled, installed onto an emulator or a
simulator, and looked at — and on the machine doing the building, one of the two
platforms may not be buildable at all, because Apple's toolchain does not exist
outside macOS.

```
apps/backend/mobile/
  stacks.py     which stack this is, and the commands it responds to
  devices.py    the emulators and simulators this machine actually has
  readiness.py  whether a platform can be built here, and what is missing
  prompt.py     the section every agent phase gets when the task is a phone app
  ../runners/mobile_runner.py   --detect | --devices | --doctor | --plan
```

**One detector, read by everyone.** `detect_stack` reads files on disk — no
model, no network — and returns the framework, the platforms, and the run,
build, test and lint command for each. The prompt layer, the subagent roster,
the workflow phases and the Electron preview all read that one answer. Writing
a second detector in TypeScript for the UI is exactly how the web side ended up
with two, and two detectors is two answers to "what kind of project is this".

**Cross-platform frameworks are detected first, deliberately.** A Flutter tree
contains a complete Gradle project and a complete Xcode project. Matching the
native detectors first would report the wrapper instead of the thing anyone is
writing, and hand the coder `./gradlew assembleDebug` for a Dart codebase.

**The doctor runs before the phase, not after the failure.** An iOS target on a
Linux runner is not a defect to retry — it is a property of the machine, and it
is answerable in milliseconds. So `mobile_section` states it up front, and tells
the agent to implement the change, verify what is verifiable, and *say* which
platform went unverified. The alternative is an hour of build attempts ending in
a red log that reads like a code error. That is also why the blocker for iOS off
macOS never says "install xcodebuild": there is no such package, and an agent
told there is will go looking for it.

**Per-task targets.** A card can say "Android only" about a repository that also
ships an Apple head. The choice reaches the backend as
`WORKPILOT_MOBILE_TARGETS` — the same lever `TDD_MODE` uses — and narrows the
platform rules the planner, every coding subtask and the QA reviewer are given.
Naming *no* platform means every platform the project has, not none: a card that
says nothing is not asking for nothing. Asking for a platform the project lacks
is ignored rather than obeyed.

**In the Kanban.** The task panel's *Mobile* tab detects the stack, lists the
real devices (`adb devices`, `emulator -list-avds`, `xcrun simctl list`), boots
the one you pick, builds, installs, launches, and shows a captured frame beside
the app's own log — never the whole device's, which is thousands of lines of
system noise around the one crash you are looking for. When a platform cannot be
built here, the panel says so instead of offering a Run button that can only
fail.

**How it is verified.** The layers split by what they need:

| Layer | Proven by | Where |
|---|---|---|
| stack detection, prompt, roster, workflow phases | fixtures and real repos | `test_mobile_stacks.py`, `test_mobile_chain.py` |
| devices and toolchain, against whatever is really installed | the machine's own `adb` / `xcrun` | `test_mobile_toolchain_contract.py`, in the existing 3-OS `test-python` matrix |
| boot → build → install → launch → capture | a real emulator and a real APK | `mobile-device-check.yml`, manual trigger |

The middle row exists because of a bug the other two could not catch: a cold
`adb devices -l` prints two lines of its own *before* the header, so a parser
that skipped a fixed first line read `* daemon started successfully` as a
device with the serial `*`. Sixty-four tests passed over it, because they all
fed the code a string somebody wrote — they tested our idea of adb. adb is cold
exactly once per machine boot, which is the first time anyone opens the Mobile
tab. Those contract tests assert what must hold *whatever* is installed, never
that a particular device exists: a runner image with one simulator fewer is not
a defect here, and a test that says otherwise gets disabled within a month.

`scripts/mobile_device_check.py` is the same code path as a command. Read-only
by default — stack, devices, toolchain verdict, no build and no device needed —
and `--launch` adds build, install, start and a captured frame:

```bash
python scripts/mobile_device_check.py --project-dir ../my-app
python scripts/mobile_device_check.py --project-dir ../my-app --launch
```

**The agent chain.** Three additions, each where it changes a decision:

| Where | What |
|---|---|
| `agents/subagents/mobile.py` | `device-runner` (installs and launches, reports; the only roster entry that touches a device) and `store-readiness-auditor` (read-only; the rules Apple and Google reject on). Both are protected from the roster cap — they are the only entries that know the project is a phone app. |
| `workflows/feature-build/workflow.yaml` | `mobile-design` before coding, `store-readiness` after QA. Both conditional on mobile files being touched, both `fresh-context`, both read-only. |
| `skills/mobile/` | the procedures: `android-developer`, `ios-developer`, `cross-platform-mobile`, `mobile-design-review`, `mobile-device-testing`, `mobile-store-readiness`, plus four agent definitions. |

`mobile-design` sits *before* `coding` because the window a phase runs in is its
declared position: a badly cut screen costs a sentence there and a full fix
cycle after QA. `store-readiness` sits after QA because it audits a finished
build — and it exists at all because store rejections cost days and **no test in
the repository catches any of them**: they are rules about configuration files
and about behaviours the suite does not look at.

### Competitive rounds (Bounty Board)

N contestants, each a `(provider, model, prompt_override)` triple, implement the
same spec concurrently in their own git worktrees. A judge then measures what
each one left on disk and proposes a winner.

```
apps/backend/bounty_board/
  board.py    orchestration: worktrees, concurrency, persistence
  runner.py   how one contestant is run — `create_agent_client(provider=…)`
  signals.py  what it produced: diff and the project's own test suite. No model
  judge.py    what that is worth
```

**The board used to score a string nobody had generated.** `runner` opened with
`from llm_client import acomplete`: the module is `core.llm_client`, the runner
puts only `apps/backend` on the path, and `acomplete` exists in it under no
name. So the import raised on every run and the `except ImportError` handler —
written for an environment where the multi-provider client "was not wired up
yet" — produced `f"[stub:{provider}:{model}] {prompt[:200]}"`. That string
embeds the contestant's own `provider:model`, so the only thing that varied
between contestants was **the number of characters in their model's name**. A
real round reported 77.9 / 77.8 / 67.9 and crowned a winner with two decimal
places of confidence. The warning that said so went to a logger nobody reads:
the runner is spawned by Electron and its stderr surfaces only on a non-zero
exit.

There is no stub any more, and that is the point rather than an omission. A
contestant whose client cannot be built ends `error` with the reason on its
card. An invisible wrong answer costs more than a visible failure.

**And the judge scored prose.** Its four terms were completion (50 points for
not crashing), coverage (the *first word* of an acceptance criterion found as a
substring anywhere in the answer), output length, and latency rank. Three
measure the shape of the answer text; the fourth measures the field. Five rules
replace them:

| Rule | What it prevents |
|---|---|
| **score the artifact** — every criterion reads the diff or a command run against it | a contest decided by how much the model wrote |
| **absent evidence renormalises, never scores zero** — `Criterion.value is None` drops that weight out of the total | a project with no test suite reading as a project whose tests fail |
| **no criterion is a rank** — efficiency is a ratio to the *best*, floored at the resolution below which a difference is noise | `1 - duration/slowest`, which gave the slowest exactly 0 whatever the gap: one millisecond cost ten points |
| **efficiency is a tiebreaker, never a verdict** — dropped entirely unless `tests` or `spec_fit` was measured | a score built only out of "returned first" |
| **the judge does not know who it is judging** — diffs arrive as `Candidate 1..N`, provider and model stripped | a judge measuring reputation |

Weights are `tests` 55, `spec_fit` 35, `efficiency` 10, renormalised over
whichever had evidence — so they are ratios between signals, not points. Two
gates come before any of them, because both describe a contestant with nothing
to score rather than one that scored badly: a status other than `completed`,
and a measured empty diff.

**`null` and `0` stay apart all the way to the card.** `quality_breakdown`
carries `null` for a criterion with no evidence, and `ContestantCard` renders
*not measured* in italics rather than `0.0`. Collapsing the two is how an
unmeasured contest comes to be read as a close one, which is exactly what
happened. Every dropped signal is also reported as a `warning` on the result and
listed in the verdict modal.

**A tie is reported as a tie.** The old `scored.sort()` was stable, so equal
scores handed the trophy to whichever contestant was declared first — at the
0.1-point margins that board produced, most rounds. `evidence_judge` returns no
winner and says the top score was tied.

**The test suite runs sequentially, once per contestant.** N suites racing over
the same ports, temp files and package caches measures the contention. And a
suite is never run against an empty diff: it would measure the base branch and
hand every do-nothing contestant a clean pass.

What `discover_test_command` returns is a CI `run:` block, which is a shell
script rather than an argv list — in this repository, `source .venv/bin/activate`
followed by `pytest`. So it is executed as one, through
`asyncio.create_subprocess_shell`, the same call `qa/auto_fix_loop._run_tests`
already makes for the same question; a `subprocess.run(shell=True)` here is both
a second answer to it and a fifteen-minute block of the event loop the
contestants ran on. The suite gets its own process group, so a timeout takes the
dev server or database it started with it rather than leaving them holding the
ports the next contestant needs — and a timeout is `unknown`, never a failure the
contestant caused.

**Credentials for every provider, and no `SELECTED_LLM_PROVIDER`.** This is the
one run that talks to several providers at once, so `bounty-board-handlers.ts`
merges `credentialManager.getEnvironmentVariables(provider)` for each and then
deletes that variable: every contestant names its own provider, which
`create_agent_client(provider=…)` honours directly, and an ambient one would be
a second answer to a settled question.

**The base of that environment is `getRunnerEnv`, not a second assembly.** It
used to be built out of `credentialManager` alone, and that object never
carries Claude's *own* authentication: the OAuth token comes from
`getBestAvailableProfileEnv` and an API profile from `getAPIProfileEnv`, both
of which every other runner in the application receives through `getRunnerEnv`.
So a Claude contestant was dispatched with no Claude credentials at all and
died on `No OAuth token found` — on an authenticated machine, in the same round
where OpenAI and Google reached their providers. Two assemblies of one
environment is how one of them quietly loses a variable, and the symptom looks
like an authentication bug rather than a wiring one.

Claude's chain is therefore left to `getRunnerEnv` and never re-stated: it
resolves OAuth mode, API profiles and rate-limit-aware profile swapping
*together*, and re-injecting a key on top of it could contradict the mode it
just chose. Only the board's other providers are layered on.

`prompt_override` reaches a model now. It was parsed from the CLI, stored on
`ContestantSpec`, and dropped by `_materialize`, so the per-entry strategy the
UI offers had no effect on anything. It is added to the brief, never
substituted for it.

**A provider with no agentic adapter never takes the field.** mistral, deepseek,
grok, meta, aws, cursor and custom are driven by the Claude SDK
(`capabilities/providers.yaml`, `degrades_to`) — the right trade for a build,
since the task runs, and the wrong one for a contest, where a win would be
recorded under the name of a vendor that never saw the prompt. It is the Arena's
`require_provider` rule, word for word, and `bounty_board/runner.py` applies it
before a client is built: that contestant ends `error` with the reason on its
card. The selector says so too, from the same matrix the Arena reads
(`GET /providers/agentic-capabilities`, via `useAgenticCapabilities`), so the
answer arrives before a round is spent learning it rather than after.

### Declarative Workflows

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
phases it declares rather than only pruning them: while eight of eleven were
played by a hard-coded sequence, switching it on bought the printed profile and
little else.

| Phase | Who runs it |
|---|---|
| `brainstorm`, `spec`, `analyze`, `frontend-design`, `review`, `adversarial-review`, `spec-conformance`, `verify` | the engine (`workflows/runner.py`), as one-shot skill sessions |
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

**A pack is not a phase.** impeccable ships two things — 23 design commands a
model reads, and 59 detector rules that run locally — and the workflow declares
one phase for each: `frontend-design` before `coding`, `design-check` after it.
Both the engine's `DETERMINISTIC_PHASES` and the runner's `_ELSEWHERE` used to
be keyed on the *pack*, which made "this check costs no tokens" and "the gate
runner owns this phase" true of everything impeccable implements. The second
phase would have been resolved, printed in the profile the user is shown, and
executed by nobody — `test_every_skill_phase_belongs_to_a_window` watches the
declaration, not that door. Both sets are keyed by phase id, and the pack still
owns the gate *command* (`pack.json` → `gate`), which is a different question.

The order is the point, and it is the same argument `mobile-design` makes one
row above: a detector grades code that exists, and by then a layout nobody
designed costs a full fix cycle rather than a sentence. Both phases read the
same glob list, declared once in `workflow.yaml` as a YAML anchor and aliased
by the second — two copies of "what counts as frontend" is how a surface ends
up designed before coding and ungraded after it.

There are **four** windows: before `planning`, between `planning` and `coding`,
between `coding` and `qa`, and after `qa`. The second one is opened from inside
`run_autonomous_agent`, because that function owns both phases it sits between —
which is also why it did not exist until a phase needed it. A phase declared
where no window opens is resolved, printed in the profile the user is shown, and
run by nobody; `test_every_skill_phase_belongs_to_a_window` is what keeps that
from happening quietly.

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
`superpowers/test-driven-development`: the skill is the *methodology*, the
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
| `spec-conformance` | `spec_validation` | not `qa-acceptance-checker` | `qa` — the subagent its own description in `workflow.yaml` had named since the phase was written |

`spec_critic` now maps in `PHASE_ALIASES`; `spec_validation` cannot, because `analyze`
reads a plan before any code exists and `spec-conformance` audits a finished branch, and
the alias table has one key per agent_type. Those two declare `roster:` in the workflow
file instead. An unknown roster name logs and falls back rather than raising: a typo in a
workflow file should cost the right specialists, not the build.

This matters beyond tidiness — the roster is context the parent pays for on **every
turn**, so a mismatched roster is not merely unhelpful, it is billed.

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

#### The resolved profile in the UI

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

### Pause, resume, and how a phase reports failure

A build is a stack — `handle_build_command` → the coder loop → a session → a
phase — and two things can happen deep inside it that the current frame has no
business resolving: the user pressed Pause, or a phase established it cannot
produce its output. Both used to be a bare `return`, which unwinds exactly one
frame. The caller could not tell "finished" from "gave up", so a build whose
planning had failed went on to run QA, the hard gates and `finalize_workspace`
over a worktree with no implementation plan in it.

`core/build_signals.py` holds the two exceptions that unwind to the entry point:
`BuildPaused` (not a failure — nothing is finalized, the card keeps its column)
and `BuildHalted` (which carries the sentence the user will read).

The planner remains the active phase until its plan passes validation. Starting
its session is not a transition: a timeout, quota wait, authentication recovery
or hot model switch must reopen planning, for every provider. The coder loop
may return normally only with a nonempty, completed plan and no session error;
an empty plan, exhausted budget or unfinished subtasks halt before QA. The loop
detector propagates `BuildPaused` too, rather than returning as if coding finished.

**The pause has one store.** `core/pause_state.py` owns `pause_state.json`,
which lives in the spec directory. That is the whole point: the flag used to
live inside `implementation_plan.json`, a file that does not exist during spec
creation or planning, so pressing Pause on a task that was visibly running
answered "Implementation plan not found". The spec directory exists from the
moment the task does.

| Reader | Checkpoint |
|---|---|
| `agents/coder.py` | top of the session loop — the same place for a planning iteration and a coding one |
| `qa/loop.py` | between review passes, so a pause does not wait out a long one |
| `spec/pipeline/orchestrator.py` | between spec phases |

The Electron side writes it through one helper too
(`ipc-handlers/task/pause-state-utils.ts`): four call sites used to clear
`plan.paused` by hand, and one missed copy means the restarted backend re-pauses
at its first checkpoint and the resume looks like it did nothing. The legacy
in-plan block is still *read* so a task paused before this change does not
silently un-pause on upgrade; nothing writes it any more.

**Resuming re-reads the disk rather than being told a phase.** `TASK_RESUME`
clears the flag and restarts `run.py`; phase entry is state-driven
(`is_first_run`, `get_next_subtask`, `should_run_qa`), so no plan means planning
runs again, an incomplete plan resumes at the first unfinished subtask, and a
complete one goes to QA — which itself continues from its persisted iteration
count. Naming a phase in the resume would be a second opinion about a question
the spec directory already answers, and the two would drift. The same property
is what makes switching provider mid-task cheap: `TASK_RESUME_WITH_PROVIDER`
rewrites the model configuration and lifts the pause, and touches nothing else —
completed subtasks, the spec and the QA sign-off stay as they are. Only an
explicit "re-run this phase" discards work, and only downstream of the phase
asked for (`plan-rerun-utils.ts`).

**Resuming continues the phase; it does not pay for it twice.** State-driven
entry answers *which* phase re-opens, and nothing more: the phase itself
re-opened with an empty head, re-read the same files and re-derived the same
analysis the interrupted session had already done. Two channels carry it
across now, one per half of the product. `TASK_RESUME` hands the subprocess the
session id in `<spec_dir>/.session.json`, so the Claude SDK rehydrates that
transcript (single-shot — `create_client` pops the variable, so only the first
session of the resumed run replays it). For every other provider it is
`conversation.<provider>-<model>.jsonl`, which `_maybe_replay_conversation`
already replayed on every session start.

**A model that is new to a phase inherits it.** The conversation log is
per-(provider, model) on purpose — switch away and back, and a model resumes
its own context. On the switch itself that property is exactly wrong: the model
the user just chose has no log, nothing is replayed, and the phase restarts from
the prompt, which is the opposite of what the Pause button promised.
`read_log_for_phase_resume` gives a model with no log of its own the **same
phase's** tail (`MAX_CARRYOVER_MESSAGES`) from whichever model last wrote one,
and writes it into the new model's log — a takeover, not an alias, so from the
next session on that model reads its own file like every other.

The phase is the whole guard, and it is not a detail: a per-phase model
configuration legitimately runs coding on a model the planner never used.
Inheriting by recency alone would replay the planner's entire reasoning into
every such coding session, on every build that names two models. An archived log
(`.too-long.`, `.trimmed.`, `.archived.`) is never inherited either — a
prompt-too-long halt archives precisely so the next run does not replay it, and
reading it back through the carry-over would fail the run the same way.

**A relaunch is owed an event.** `TASK_START` tells the machine it is starting
(`determineStartEvent`); resuming told it nothing, and a machine left settled in
`human_review`/`error` keeps the review reason and the failure message that go
with it — so the red "this task failed" banner stayed at the top of a task that
was visibly running again, quoting the run it had replaced. `relaunchEventFor`
is the one answer to what the two resume paths owe it, and the sequence counter
is reset in the same breath: a restarted backend numbers its events from zero,
and `isNewSequence` drops anything below the last number it saw, so without it
the resumed run's phases reached nobody at all.

**Pause and Reprendre belong to the run, not to the column.** A paused task
keeps the status it was paused in — often `human_review`, once a phase reported
a failure — and the task panel's action bar was keyed on status, so the one
screen that owns the provider/model/effort switch was the one screen that could
not simply resume. `TaskRunControls` is now answered from the pause flag first,
before any status branch, which is how the kanban card had always decided it.

**And the model it resumes with is picked, never typed.** The panel's
"Autre (catalogue officiel)" row is a door, not a model: it opens
`OfficialModelSearch` over the provider's own library, which is the same thing
the per-phase selector does and for the same reason. A free-text field accepts
`gemma4:12b-it-q4_K_M` whether or not anything published it, and the only
symptom is the resume failing on `pull model manifest: file does not exist` —
after the restart, under a name the user has no way to check.

**A phase that gives up says so.** `PLANNING_FAILED` and `CODING_FAILED` were in
the XState machine from the start and emitted by nobody: every real failure
reached the frontend as a process exit, and the machine's `setError` did not
handle that event. The result was a card in Human Review with a red *Has Errors*
badge and no reason anywhere in the UI — the toast even announced it as "Ready
for Review", because the status is the same one a finished build gets.

Now each halt emits the event with its message (`_emit_phase_failure` in
`coder.py`, `_emit_planning_failed` in the spec orchestrator, `_emit_fatal_error`
for an unhandled crash, `_emit_startup_failure` for a prerequisite the build
could not satisfy — that last one because `validate_environment` ends in
`sys.exit(1)`, and SystemExit is not an `Exception`, so the crash emitter never
saw it and a cause known in full went to the card as "exited unexpectedly with
code 1"), `setError` covers every event that can reach the `error`
state — including `PROCESS_EXITED`, whose message names the exit code because
that is still better than nothing — and the message is persisted beside the
status it explains (`plan.errorMessage`) so it survives a reload.
`TaskFailureBanner` renders it at the top of the task panel, and the toast reads
`reviewReason` rather than the column before choosing its wording.

### Le mode hors-ligne : une barrière, ou un défaut

`.workpilot/offline-mode.json` porte deux politiques sous un seul nom, et les
confondre est ce qui a fait mourir un Bounty Board configuré sur Anthropic
sur `ValueError: Local model llama3.3:latest is unavailable on ollama` — un
fournisseur que personne n'avait sélectionné, un modèle que personne n'avait
nommé, et pas un mot sur l'origine de l'un ni de l'autre.

| `airgapStrict` | Ce que la table de routage est |
|---|---|
| `true` | **une barrière.** Elle remplace ce que l'appelant voulait, et une route impossible à honorer est une erreur dure : il n'y a pas de repli légal, puisque tout l'objet est qu'aucun appel cloud ne quitte la machine |
| `false` | **un défaut.** La page le dit elle-même : « le mode strict est désactivé : les opérations sans route locale peuvent encore utiliser le cloud ». Un défaut répond pour l'appelant qui n'a rien nommé ; il ne tranche pas à la place de celui qui a nommé quelque chose |

`resolve_offline_route` reçoit donc un `chosen` — vrai quand le couple
(fournisseur, modèle) est une décision prise pour cette exécution, faux quand
c'est le défaut `core.client._DEFAULT_PROVIDER` que personne n'a demandé. Sans
lui, **tous** les appelants avaient l'air explicites : `create_agent_client`
résout le fournisseur *avant* d'appeler, si bien qu'une table hybride
redirigeait silencieusement les six phases nommées (`planner`, `coder`,
`qa_reviewer`, `commit_message`, `summary`, `triage`) de chaque build vers un
modèle local, et que le seul symptôme était un message nommant un fournisseur
jamais choisi.

C'est `_resolve_active_provider` qui répond aux deux moitiés — *quel
fournisseur*, et *quelqu'un l'a-t-il nommé* — et `_get_active_provider` n'est
plus qu'un appel dessus. Une seconde chaîne de résolution pour répondre à la
deuxième moitié aurait dérivé de la première au premier changement.

**Un couple local choisi reste validé, et une erreur reste une erreur.**
Exécuter Anthropic parce qu'Ollama n'est pas démarré est une substitution que
personne n'a demandée, et le silence ferait passer un modèle indisponible pour
un modèle qui répond mal. Seule une **route hybride** — un défaut que la
fonction a appliqué d'elle-même — s'efface au lieu d'échouer, en le disant dans
le journal : faire échouer un build sur un défaut est le seul résultat que
personne n'a demandé, et le mode hybride autorise le cloud par définition.

**Et le message nomme sa source.** « Local model X is unavailable on ollama »
décrivait parfaitement ce qui n'allait pas et rien de ce qu'il fallait savoir :
quelle tâche, quelle politique, et quoi faire. Il nomme désormais la route qui a
désigné ce modèle, le fournisseur qu'elle a *remplacé*, et la sortie —
`STRICT_EXIT_HINT`, écrite une fois. Un message qui décrit une barrière sans
dire où est l'interrupteur laisse son lecteur chercher dans les réglages d'un
produit qui en a quatre-vingts.

#### Le défaut d'un fichier absent n'est pas une barrière

Tout ce qui précède décrit le mode strict comme une décision. Il ne l'était pas :
`_default_policy` — ce que la page propose à un projet qui n'a jamais rien
configuré — renvoyait **`airgapStrict: True`**, avec les six tâches routées vers
le premier modèle local par ordre alphabétique. Le store marque une politique
non persistée `dirty`, donc le bouton Enregistrer est actif dès le premier
rendu : ouvrir la page par curiosité et cliquer une fois coupait tout
fournisseur cloud du projet.

Le symptôme arrivait bien plus tard et ailleurs — un Bounty Board configuré sur
Anthropic, OpenAI et Google mourant trois fois sur
`llama3.3:latest is unavailable on ollama`, un modèle que personne n'avait
nommé — et la seule façon de faire le lien était de rouvrir cette page.

Le *fail-closed* est la bonne règle pour **honorer** un airgap que quelqu'un a
demandé. Appliqué à l'absence d'un fichier, il devient un fail-closed contre
l'intention de l'utilisateur, ce qui est autre chose portant le même nom. Le
défaut est `False` ; activer la barrière reste un geste, et la case cochée se
rend désormais comme une alerte plutôt qu'en texte gris — c'est la seule bascule
du produit qui désactive tous les fournisseurs cloud.

#### Le mode strict est lisible ailleurs que sur sa propre case

`_status()` ne portait que les runtimes locaux, si bien que « ce projet est en
airgap » n'était lisible nulle part ailleurs que sur la page Mode hors-ligne.
Partout ailleurs — la liste « Fournisseur IA », le Bounty Board, l'Arena — le
fournisseur choisi s'affichait avec sa pastille verte et le backend refusait
l'appel une seconde plus tard.

| Qui répond | Où |
|---|---|
| le fait, et **quel fichier** le décide | `offline_policy.airgap_status` |
| « ce fournisseur tourne-t-il sur la machine ? », quelle que soit son orthographe | `offline_policy.is_local_provider` |
| le statut servi à l'UI (`airgapStrict`, `policyPath`, `policyPersisted`) | `offline_mode_runner._status` |
| le renderer | `useAirgapStatus` |

`_policy_files` est extrait de `project_policies` pour que « quel fichier le
dit » et « que dit-il » soient une seule recherche lue deux fois : une seconde
remontée d'ancêtres écrite ailleurs répondrait à côté le jour où un projet
hérite de la politique d'un répertoire parent — ce qui est précisément le cas
que `project_policies` existe pour couvrir.

**Le Bounty Board refuse un participant cloud avant de le lancer.** En mode
strict, chacun était réécrit vers le modèle local de la politique : un plateau
de trois fournisseurs cloud devenait trois fois le même modèle — ou, quand ce
modèle n'est pas installé, trois fois la même erreur. C'est la même règle que
pour un fournisseur sans adaptateur agentique, pour la même raison, et un
concours entre modèles **locaux** reste parfaitement légitime.

#### L'interrupteur est là où la barrière se manifeste

Le message ci-dessus décrivait la barrière puis renvoyait ailleurs : « décochez
Mode strict dans Réglages → Mode hors-ligne ». C'est une instruction de
navigation, pas une réponse — et elle demande d'aller décocher, dans un autre
écran, une case que personne n'avait cochée. `AirgapBanner` porte donc le
bouton, et `useAirgapStatus.disableStrict` l'exécute.

Ce que le bouton ne fait pas, c'est décider : lever un airgap reste un geste
explicite, sur un clic, avec le fichier concerné écrit à l'écran. Une migration
qui aurait désactivé le mode strict des politiques existantes serait la faute
d'origine à l'envers — quelqu'un qui a vraiment voulu l'airgap le perdrait sans
qu'on le lui demande.

**La désactivation renvoie la politique persistée telle quelle**, `airgapStrict`
mis à `false` et pas un champ de plus. C'est la seule forme que `_save_policy`
accepte sans revalider le routage (`disabling_only`), et cela compte exactement
ici : la politique qui piège l'utilisateur route vers un modèle désinstallé,
souvent avec le serveur local éteint, donc toute écriture prétendant la
« corriger » au passage serait refusée et le bouton ne ferait rien.
`test_strict_can_be_lifted_with_a_missing_model_and_no_server` est ce qui garde
cette porte ouverte.

**Un airgap hérité d'un parent n'offre pas de bouton.** La recherche remonte les
répertoires ancêtres, alors que `set-policy` n'écrit que dans
`<projet>/.workpilot/` — et la résolution est stricte dès qu'une *seule* des
politiques trouvées l'est. Un bouton y créerait une seconde politique sans rien
débloquer, ce qui est pire que pas de bouton ; `_status` répond donc
`policyIsProjectOwn`, en comparant des chemins **résolus** plutôt que des
chaînes.

### Workflow Logger

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

## Frontend Development

### Tech Stack

React 19, TypeScript 5.9 (strict), Electron 41, Zustand 5, Tailwind CSS v4, Radix UI, xterm.js 6, Vite 8, Vitest 4, Biome 2, Motion (Framer Motion)

### Path Aliases (tsconfig.json)

| Alias | Maps to |
|-------|---------|
| `@/*` | `src/renderer/*` |
| `@shared/*` | `src/shared/*` |
| `@preload/*` | `src/preload/*` |
| `@lib/*` | `src/renderer/lib/*` |

Components live in `src/renderer/components/`, hooks in `src/renderer/hooks/`.

`@features/*`, `@components/*` et `@hooks/*` ont été retirés : ils étaient
déclarés dans `tsconfig.json`, `vitest.config.ts` et `electron.vite.config.ts`,
pointaient vers des répertoires qui n'ont jamais existé, et aucun fichier
n'importait au travers. Cette table les documentait comme inutilisables au lieu
de les supprimer.

### State Management (Zustand)

96 stores in `src/renderer/stores/`. Key stores:

- `project-store.ts` — Active project, project list
- `task-store.ts` — Tasks/specs management
- `terminal-store.ts` — Terminal sessions and state
- `settings-store.ts` — User preferences
- `github/issues-store.ts`, `github/pr-review-store.ts` — GitHub integration
- `insights-store.ts`, `roadmap-store.ts`, `kanban-settings-store.ts`
- `self-healing-store.ts` — Incident management and production response
- `pixel-office-store.ts` — Multi-agent Pixel Office visualization
- `learning-loop-store.ts` — Learning analytics
- `app-emulator-store.ts` — App preview/emulator
- `arena-store.ts` — Model comparison arena
- `mcp-marketplace-store.ts` — MCP server marketplace
- `code-migration-store.ts`, `design-to-code-store.ts`, `visual-to-code-store.ts` — Code transformation
- `performance-profiler-store.ts`, `conflict-predictor-store.ts` — Analysis

Main process also has stores: `src/main/project-store.ts`, `src/main/terminal-session-store.ts`

### Styling

- **Tailwind CSS v4** with `@tailwindcss/postcss` plugin
- **7 color themes** (Default, Dusk, Lime, Ocean, Retro, Neo, Forest) defined in `src/shared/constants/themes.ts`
- Each theme has light/dark mode variants via CSS custom properties
- Utility: `clsx` + `tailwind-merge` via `cn()` helper
- Component variants: `class-variance-authority` (CVA)

### IPC Communication

Main ↔ Renderer communication via Electron IPC:
- **Handlers:** `src/main/ipc-handlers/` — organized by domain (github, gitlab, ideation, context, etc.)
- **Preload:** `src/preload/` — exposes safe APIs to renderer
- Pattern: renderer calls via `window.electronAPI.*`, main handles in IPC handler modules

**A page never owns its subscription.** Every `setup<X>Listeners()` is registered
once for the life of the window by `stores/global-listeners.ts`, called from
`App.tsx`. It used to be called by the page component, in a `useEffect` whose
cleanup ran on unmount — and `App.tsx` unmounts a view the moment the user
navigates away. The work itself never stopped (it runs in the main process), but
nobody was listening: progress events fell on the floor, the store stayed on
`isGenerating: true` for ever, and coming back to the page showed a run that had
finished ten minutes earlier. Thirty-seven features had the same bug, because
they all copied the same shape.

Registering twice is worse than registering never — the stores that append
(ideas, log lines, findings) would double their content — so the bootstrap is
idempotent and the invariant test in
`stores/__tests__/global-listeners.test.ts` ("no page component registers IPC
listeners of its own") fails the build if a page takes the
subscription back. A listener that needs a project reads it at event time
(`useProjectStore.getState().selectedProjectId`) rather than capturing it, which
is what makes the session scope possible at all.

### Background work and the sidebar (`stores/activity-store.ts`)

Work that outlives the page needs somewhere to be *seen*. `activity-store` is
the one registry: a feature reports `running → success | error`, and the sidebar,
the toasts and the background indicator all read that instead of each feature
inventing its own signal. `stores/activity-bridge.ts` derives it from a store's
own phase, so the four ways a generation can end (complete, error, timeout,
stopped) are covered once rather than hooked one by one.

The model is unread mail, not notification. A finished job leaves a silent mark
that survives navigation and clears when the page is visited; the page the user
is currently watching never badges itself.

| Rule | Why |
|---|---|
| running is a static hollow ring, never an animation | eight active pages must stay readable; motion is for what *changed* |
| at most one entry animates, three pulses, then still | two pages finishing together is one animation and one silent badge — the difference between a signal and a light show |
| a failure keeps the slot a later success would have taken | the eye is spent on the thing worth acting on |
| shape carries the state, colour only doubles it | seven themes, and colour-blind users |
| a folded group carries the worst state of its entries | `navGroups` are collapsed by default, so work behind one would be invisible |
| the badge is `role="img"`, not a live region | a live region on ~80 entries announces the whole sidebar on every change |

Animation is capped by the global `prefers-reduced-motion` block in
`globals.css`, so nothing new has to opt in.

**Who reports, and where that is decided.** `stores/activity-bridges.ts` is the
single table: it maps a feature store to the menu entry its work belongs to.
The mapping lives there rather than in each store, so a feature store never
imports the sidebar — it publishes a phase, and one file decides what that
phase means to a menu entry.

Nineteen stores independently converged on `idle | <one verb> | complete |
error`, which is what makes `bridgePhaseActivity` enough for all of them: the
running verb (`scanning`, `analyzing`, `generating`, `optimizing`) also names
the job, because the badge already sits on the entry that names the feature —
"Doc Drift — Doc Drift" was the alternative. Roadmap, ideation and the Kanban
keep their phase elsewhere and get an explicit bridge.

Two absences are deliberate. **self-healing** has no phase, only `isLoading`:
badging a menu entry for a list refresh is the noise this design exists to
avoid. **smart-estimation** and the other dialogs have no `SidebarView`, and a
badge needs an entry to sit on.

**The activity centre** (`components/ActivityCentre.tsx`) answers *what* is
running, where the badges answer *where*. It lists work on every page except
the one on screen — that page shows its own work in full — and keeps a finished
job listed until its page has been visited, on the same unread rule the badges
use. It replaced the Kanban-only running-tasks pill: agents were never the only
thing that kept working after the user left a page, only the only thing that
said so.

**Re-hydrating on mount must not answer for work in flight.** A page that reads
its state from disk when it opens runs that code again every time the user
navigates back, and `App.tsx` remounts the view each time. `loadArchitectureState`
used to set `checking` and then `idle` unconditionally, so leaving the
Architecture page mid-generation and coming back showed an empty page with a
Generate button — while the map was still being built in the main process, and
the sidebar badge was dropped along with the phase. The service is the authority
on whether it is still busy, and `checkArchifyReadiness` returns `running`
alongside the doctor's verdict: one round trip, at the moment the decision is
made. `loadRoadmap` had the same shape from the start (`getRoadmapStatus`) and
`loadIdeation` bails out while `isGenerating`; those two and this one are the
only mount-time re-hydrations that write a not-running state.

**Toasts are coalesced, not stacked.** `use-toast` keeps a single slot
(`TOAST_LIMIT = 1`), so three pages finishing together used to mean two
announcements nobody saw. `useActivityNotifications` collects finishes for
~1.2s and raises one toast for the batch, with a failure in it deciding the
wording and the variant. Raising the limit would stack three cards over the app
instead; collecting them stays true as the number of pages grows. Kanban builds
are excluded there — `useTaskNotifications` already announces those, with the
task title and the distinction between a finished build and one that landed in
review because it failed.

### Le pourcentage d'une tâche (`shared/progress.ts`)

Une exécution produit **deux** nombres, et un seul répond à « où en est cette
tâche ? » :

| Champ | Échelle | Exemple |
|---|---|---|
| `phaseProgress` | 0-100 **à l'intérieur** de la phase courante | 15 = 15% de la planification |
| `overallProgress` | 0-100 sur **toute** la tâche, pondéré par `EXECUTION_PHASE_WEIGHTS` (planification 0-20, codage 20-80, QA 80-95) | 3 = 15% × la bande 0-20 |

Les deux étaient affichés côte à côte comme s'ils étaient comparables : la carte
du Kanban imprimait `phaseProgress` brut (« Planification 15% ») pendant que la
pop-in de détail imprimait `overallProgress` (« 3% »), pour la même tâche au même
instant. Le second est le bon, et c'est le seul qu'on montre désormais —
`resolveOverallProgress` le reconstitue depuis la phase quand l'enregistrement ne
le porte pas (plan persisté, snapshot XState), pour qu'aucune surface ne retombe
sur l'échelle locale à la phase.

La pondération elle-même vit dans `shared/progress.ts::calculateOverallProgress`
et **nulle part ailleurs** : `agent-events` l'appelle pour émettre, le renderer
l'appelle pour reconstituer. Deux copies de la formule, c'est deux réponses à une
question — exactement ce que 3% contre 15% donnait à lire.

La restauration d'une tâche depuis le disque suit la même règle : elle sait
quelle phase était en cours, pas où elle en était, donc elle suppose le milieu de
phase (`phaseProgress: 50`) et **pondère** — une tâche en planification revient à
10%, pas au 50% qui y était écrit en dur quelle que soit la phase.

Au-dessus de tout cela, `getDisplayProgress` garde ses deux priorités : dès qu'il
existe des sous-tâches, leur part terminée EST l'avancement réel (la pondération
par phase gonflerait à ~94% dès le démarrage de la QA), et un état terminal vaut
100% quel que soit un comptage en retard.

### Les critères d'acceptation en puces (`task-detail/acceptance-criteria-draft.ts`)

Les critères sont un `string[]` dans `task_metadata.json`, et ils s'éditaient
dans un textarea où une ligne valait un critère. Le format lit bien et s'édite
mal : une ligne de textarea n'est pas une chose. En supprimer une au milieu,
en déplacer une, savoir combien il y en a — ce sont trois opérations sur du
texte, faites à la main, sans rien pour dire qu'on s'est trompé de ligne.

Chaque critère est maintenant une puce à part entière : son champ, son bouton
de suppression, sa place dans la liste. Ce qui rend la chose possible est un
`id` stable par ligne (`CriterionDraft`), indépendant du texte et de la
position : c'est la clé React, et c'est la cible du focus après une insertion
ou une suppression. Un id dérivé du texte ferait de deux critères identiques
une seule ligne, et changerait à chaque frappe.

| Fichier | Rôle |
|---|---|
| `acceptance-criteria-draft.ts` | les règles sans React : découpage d'un collage, marqueurs de puce, insertion / suppression / déplacement, ce qui part à l'enregistrement |
| `AcceptanceCriteriaEditor.tsx` | les puces, le clavier et le focus |
| `TaskMetadata.tsx` | la section, les deux modes, l'enregistrement |

**Le mode texte reste offert à côté.** La liste est le mode par défaut et le
texte brut d'avant est à un clic : c'est lui qui fait bien ce que les puces
font mal — coller dix critères, en réordonner la moitié, tout effacer d'un
geste. Les deux éditent la même liste, et le passage de l'un à l'autre garde
la ligne vide qu'on vient d'ouvrir — d'où la chaîne propre au mode texte,
plutôt qu'un texte dérivé des puces à chaque frappe, qui supprimerait la ligne
sur laquelle on est en train de taper.

**Un critère tient sur une ligne**, parce que tout ce qui le relit découpe sur
les retours à la ligne. Entrée ouvre donc une puce au lieu d'insérer un saut,
un bloc collé devient une puce par ligne, et la normalisation se reprend à
l'enregistrement — un glisser-déposer de texte dans un champ n'appuie sur
aucune touche.

**Le marqueur de puce est retiré plus prudemment qu'à la lecture des
trackers.** `parseAcceptanceCriteriaText` lit un `<li>` où le marqueur est
certain ; ici la ligne vient de l'utilisateur, et « 3 tentatives maximum »
n'est pas une liste numérotée. Un chiffre ne compte comme marqueur que suivi
d'un point ou d'une parenthèse, et un marqueur doit être suivi d'une espace.

**Une puce vide n'est pas un critère** : elle existe dans l'éditeur, elle ne
part pas sur le disque. C'est ce qui permet de garder toujours un champ où
taper — supprimer la dernière puce en laisse une vide plutôt qu'une liste sans
champ — sans empêcher d'effacer la liste entière.

### Architectures et historique de construction (`visual-to-code/`)

Le canvas ne tenait qu'**un** diagramme, dans trois champs libres du store
(`canvasNodes`, `canvasEdges`, `canvasDiagramType`). En commencer un deuxième
détruisait le premier : « Nouveau diagramme » vidait le canvas, et la seule
façon de garder le travail était d'avoir pensé à exporter un JSON avant.

Une **architecture** est désormais un document — un id, un nom, ses blocs, ses
connexions — et les documents sont indépendants. L'id est ce sous quoi
l'historique est classé sur disque, ce qui est la raison pour laquelle il
survit à un renommage.

| Où | Quoi |
|---|---|
| `stores/visual-to-code-store.ts` | les documents, le document actif, et les actions d'historique |
| `components/visual-to-code/ArchitectureTabs.tsx` | la barre d'onglets ; c'est là que se crée un document |
| `components/visual-to-code/ArchitectureHistoryDock.tsx` | la frise des étapes, et le retour à l'une d'elles |
| `main/visual-to-code-history.ts` | le stockage : un fichier par architecture |
| `shared/types/visual-to-code-history.ts` | les types que les trois processus partagent |

**La migration n'est pas optionnelle.** Le store persiste en `version: 2` avec
un `migrate` qui transforme l'ancien diagramme unique en une première
architecture nommée. Quelqu'un qui avait un diagramme ouvert au moment de la
mise à jour doit le retrouver là où il l'a laissé — découvrir la fonctionnalité
en perdant son travail n'est pas une migration.

**L'historique est sur disque, pas dans `localStorage`.** Soixante instantanés
d'une architecture de quarante blocs, multipliés par le nombre de documents
ouverts, c'est des mégaoctets contre un quota d'environ 5 Mo que toute
l'application se partage — et un quota qui déborde lève à l'écriture, en
perdant silencieusement exactement le travail que la fonctionnalité existe pour
protéger. Un fichier par architecture sous
`userData/visual-to-code/history/<id>.json` : un instantané ne réécrit que le
document concerné, et supprimer une architecture supprime un fichier au lieu de
réécrire celui de tout le monde. Le fichier porte les corps, mais
`listVersions` ne renvoie que les métadonnées : le panneau dessine soixante
lignes, il n'a pas à recevoir soixante diagrammes pour ça.

**Une étape n'est pas une modification.** `signature` compte les positions —
déplacer un bloc est une édition, et l'annulation doit la reprendre.
`structuralSignature` les ignore, et c'est lui qui déclenche la capture : une
frise dont quarante lignes disent « bloc déplacé » est une frise que personne
ne parcourt. Les positions du moment voyagent quand même dans l'instantané de
l'étape suivante, donc rien n'est perdu. La capture est temporisée à 1,5 s,
bien au-delà des 350 ms de la pile d'annulation : celle-ci parle du dernier
geste, la frise parle de la forme d'un après-midi de travail.

**Restaurer ajoute, ne rembobine pas.** Les étapes postérieures à celle qu'on
restaure restent exactement où elles sont, et la restauration devient elle-même
la plus récente. Revenir voir mardi ne doit pas être le geste qui supprime
mercredi — et l'annulation d'une restauration n'est alors qu'une autre
restauration.

**Nommer une étape, c'est la conserver.** Le plafond de 60 ne compte que les
étapes anonymes ; une étape nommée est une décision, et un plafond n'a pas à
supprimer une décision. Les deux gestes sont un seul dans l'UI, parce que
demander les deux séparément reviendrait à regarder des étapes nommées tomber
du bas de la pile.

**Le miroir vers le store est regroupé (250 ms).** Un déplacement émet un
changement par frame, et le miroir écrivait chacun d'eux — ce qui re-rend
maintenant aussi la barre d'onglets. Tant que le canvas est monté, c'est *lui*
la vérité ; la copie du store existe pour survivre à la navigation et au
redémarrage. Ce qui rend le regroupement gratuit, c'est que les deux chemins
qui peuvent écourter la fenêtre — changer d'onglet, quitter la page — vident
d'abord (`flushMirror`). Un regroupement qui ne viderait pas serait une perte
de données déguisée en optimisation.

**`loadedArchitectureId` est un état, pas une ref**, et c'est tout l'argument de
correction : sur le rendu où le document actif change, le miroir s'exécute avec
le *nouvel* id et les *anciens* blocs. Une ref posée par le chargeur dans le
même commit se lirait déjà à jour, et le miroir écrirait les blocs d'un
document dans un autre.

### L'adresse qu'ouvre l'émulateur (`shared/utils/emulator-landing.ts`)

L'aperçu ouvrait la racine du serveur. C'est la bonne réponse pour un site et la
mauvaise pour tout le reste : une Web API .NET répond 404 sur `/`, et la page que
la tâche vient d'écrire est trois segments plus loin. L'utilisateur voyait donc,
pour une fonctionnalité qui marche, un cadre vide et « HTTP 404 ».

Le diff de la tâche dit précisément quelle route a été touchée. C'est une preuve
mesurée, pas une convention devinée, et ce module est le seul endroit qui la lit
— ni modèle ni réseau, seulement des chemins et des lignes ajoutées, si bien que
l'UI peut poser la question avant d'avoir démarré quoi que ce soit.

`deriveLandingCandidates` rend *toutes* les adresses plausibles, la plus probable
d'abord, dans l'ordre de la force de la preuve :

| Rang | Source | Ce qui la produit |
|---|---|---|
| 1 | `route-declaration` | `[Route("api/[controller]")]`, `app.MapGet`, `@Controller`, `<Route path>`, `@app.get`, `@RequestMapping`… lus dans les **lignes ajoutées** du patch |
| 2 | `file-route` | une page créée par convention : `app/x/page.tsx`, `pages/x.vue`, `src/routes/x/+page.svelte`, `app/routes/x.new.tsx` |
| 3 | `launch-profile` | le `launchUrl` que le projet déclare dans `Properties/launchSettings.json` |
| 4 | `api-docs` | la page d'accueil du framework : `/swagger`, `/docs`, `/api` |

Rendre la liste plutôt que la seule réponse est ce qui permet au panneau d'échec
de proposer les autres : un 404 sur la première devient un bouton vers la
deuxième, pas un cul-de-sac.

**Un segment dynamique arrête la route.** `api/users/{id}/roles` devient
`/api/users` : la liste existe presque toujours, l'identifiant non, et inventer
un `id` produirait un 404 en prétendant l'éviter. `[controller]` fait exception —
c'est un jeton à substituer, pas un paramètre, et son nom vient de la classe que
le patch déclare, sinon du fichier, parce qu'ASP.NET *impose* que
`DocumentsController` vive dans `DocumentsController.cs`.

**Un motif trop courant est réservé aux fichiers de routes.** `path:` est une clé
de configuration autant qu'une route Angular ; `deriveLandingCandidates` ne la
lit que dans un fichier dont le nom le dit (`*routes*`, `*router*`, `urls.py`,
`*-routing.*`). Sans cette règle, un `{ path: 'dist/assets' }` de build devenait
l'adresse proposée à l'utilisateur.

**La barre d'adresse est une vraie barre d'adresse.** `ResponsivePreview` porte
Précédent / Suivant / Recharger / Accueil et un champ éditable :
`resolveAddressInput` résout ce qui est tapé contre le serveur de l'émulateur. Le
défaut est *relatif* — dans cette barre on tape « /swagger » cent fois pour une
fois où l'on tape un hôte — et un hôte n'est reconnu que quand il se nomme (un
point, un port, ou `localhost`). Tout ce qui n'est pas http(s) est refusé avec un
message : un `file://` chargé dans l'aperçu serait une navigation que personne
n'a demandée.

La navigation passe par `loadURL`, jamais par un changement de `key` : remonter
le `<webview>` perdrait l'historique, et l'historique est ce que lisent les deux
boutons. `src` reste le repli — c'est tout ce dont dispose un environnement de
test, et c'est aussi ce qui fait la première navigation.

**« Ouvrir dans le navigateur » ouvre ce qui est affiché**, pas la racine du
serveur : après une navigation dans l'aperçu les deux ne sont plus la même page,
et sur une Web API la racine est précisément celle qui répond 404. Côté main,
`open-external.ts` est le seul chemin : il valide le schéma, appelle
`shell.openExternal`, et **sur Linux seulement** essaie ensuite les lanceurs que
la machine a vraiment (`xdg-open`, `gio open`, `x-www-browser`…) — Electron y
rejette quand `xdg-utils` manque ou que le portail XDG n'est pas joignable. Le
rejet remonte jusqu'au renderer, qui l'affiche : un bouton qui ne fait rien et ne
dit rien est la pire des deux options, et c'est ce que l'utilisateur voyait.

**Et il n'ouvre que ce qui s'ouvre.** Un `<webview>` n'annonce pas seulement les
adresses qu'on lui a demandées : `about:blank` avant sa première navigation, et
`chrome-error://chromewebdata/` dès qu'une page n'a pas répondu — ce qui est le
cas courant ici, puisqu'une Web API répond 404 sur la racine. Ces valeurs
arrivaient telles quelles à `open-external.ts`, qui les refuse à juste titre sur
le schéma : le bouton ne produisait plus qu'un message d'erreur, pour une page
que le serveur sert très bien deux segments plus loin. `isBrowsableUrl` est la
seule réponse à « est-ce une adresse ? » — la barre ne suit plus ce qui n'en est
pas une, et le bouton retombe sur la racine du serveur, toujours ouvrable. Le
message d'échec, lui, est rendu comme un échec : il était rendu en texte courant,
au milieu d'un panneau qui n'avait pas changé par ailleurs.

**L'adresse survit au changement d'onglet.** `TabsContent` démonte le panneau
qu'on quitte, donc une adresse gardée dans `ResponsivePreview` est une adresse
perdue à l'aller — l'utilisateur revenait sur l'onglet Émulateur et retrouvait la
route d'accueil. Elle vit dans `app-emulator-store` (`previewUrls`), **indexée
par tâche** : le serveur est unique, les pages qu'on y regarde ne le sont pas, et
une seule adresse ferait ouvrir la tâche B sur la page de la tâche A. Un autre
serveur les vide toutes — la page d'un run précédent n'existe plus.

Ce qui est mémorisé est une page où l'on est *allé* : une saisie, un lien suivi,
un candidat cliqué. Pas la route d'accueil que l'aperçu ouvre tout seul, ni le
premier `did-navigate` qui ne fait que la confirmer — le diff de la tâche est lu
une seconde après le montage, donc une racine mémorisée comme un choix gagnerait
contre la route que ce diff révèle. C'est la même distinction que porte le second
argument d'`onNavigate`.

### Le chemin d'une tâche, en graphe (`shared/utils/change-graph.ts`)

La liste des fichiers d'un diff répond à « quoi ? » et jamais à « pourquoi
ensemble ? ». Une propriété ajoutée à une entité du Domain, reprise par un DTO
de l'Application, exposée par un contrôleur et vérifiée par un test est un
*chemin*, et il se lit dans le diff lui-même. L'onglet **Graphe des
modifications** du panneau de tâche (`TaskChangeGraph`, entre Sous-tâches et
Logs) le dessine, et le raconte :

> J'ai modifié la classe UserProfile dans la couche Domain et j'y ai ajouté la
> propriété BirthDate.
> ↳ Le DTO UserProfileDto reprend les données de la classe UserProfile (couche
> Domain) pour les faire passer à la couche Application.

| Question | Où elle se lit |
|---|---|
| quels éléments ? | les déclarations du patch (classe, interface, record, composant, hook…) ; un fichier qui n'en révèle aucun devient un nœud fichier |
| qu'est-il arrivé à leurs membres ? | une signature vue du seul côté `+` est ajoutée, du seul côté `-` retirée, des deux côtés modifiée ; un corps changé sous une signature en contexte modifie ce membre |
| dans quelle couche ? | le chemin : tests d'abord, puis les projets d'une solution (`App.Domain/`, `.Application/`, `.Infrastructure/`, `.Api/`), puis les dossiers qui le suggèrent |
| quel lien ? | une ligne que la tâche laisse dans A cite le nom de B — gardée comme **preuve** et affichée au clic sur l'arête. Bases (`: IFoo`) → hérite / implémente, handler → commande : traite, DTO → entité : transporte, test → teste, sinon utilise |
| pourquoi ? | les sous-tâches du plan qui déclarent le fichier |

**Aucun modèle, aucun réseau** — la même règle qu'`emulator-landing.ts`. Le
graphe est donc là dès qu'un diff existe, il ne coûte rien, et surtout il ne
peut pas raconter une relation que le code ne porte pas : une phrase générée
par un modèle se lirait exactement pareil qu'elle soit vraie ou non. Les
phrases sont des gabarits i18n (`tasks:changeGraph.*`) remplis avec des faits
mesurés.

**Pourquoi pas Graphify directement.** Graphify construit le graphe de *tout*
un dépôt, depuis l'AST, dans un processus Python lancé par un hook git ; la
question ici est ce qu'*un diff* a changé, membre par membre, et elle doit
répondre dans le renderer sans rien installer. Le graphe s'exporte en revanche
**au format node-link de Graphify** (`toGraphifyNodeLink`, bouton « Exporter
graph.json ») : mêmes clés que `brain/graph.py`, `metadata.origin =
"workpilot-change-graph"`, si bien que Graphify, son serveur MCP et le skill
`graph-first-recall` le lisent tels quels.

Les lockfiles et snapshots sont écartés et comptés ; au-delà de 60 nœuds, les
plus chargés sont gardés et le reste est compté — un graphe de trois cents
nœuds est une liste de fichiers dessinée.

### Provider × LLM × effort, par page (`shared/utils/page-llm.ts`)

Une page qui lance un agent posait la question deux fois et n'en gardait qu'une
moitié : le modèle et l'effort venaient de `featureModels` / `featureThinking`,
et le fournisseur ne venait de *nulle part*. La liste « Fournisseur IA » en haut
à droite ne servait qu'aux builds du Kanban, si bien qu'une revue de PR repartait
sur Claude alors que l'utilisateur avait choisi Copilot une seconde plus tôt —
`getRunnerEnv()` n'injectait aucun `SELECTED_LLM_PROVIDER`.

`shared/utils/page-llm.ts` est l'unique réponse à « avec quoi cette page
tourne-t-elle ? », et l'ordre est celui déjà établi, une source par cran :

| Ce qui décide | Fournisseur | Modèle | Effort |
|---|---|---|---|
| 1. la page (`pageLlmOverrides[page]`) | ✔ | ✔ | ✔ |
| 2. les réglages (`selectedProvider`, `featureModels`, `featureThinking`) | ✔ | ✔ | ✔ |
| 3. les défauts du dépôt (`DEFAULT_FEATURE_*`) | — | ✔ | ✔ |

Un cran vide n'en consomme pas un autre : une page qui ne nomme que le
fournisseur garde le modèle et l'effort des réglages, et une page qui ne nomme
rien se comporte comme avant. Le champ absent est **retiré** de
`pageLlmOverrides` plutôt que stocké vide — c'est ce qui garde « aucun choix » et
« le même choix que les réglages » distincts, et qui fait qu'un changement de
fournisseur global bouge bien les pages qui n'ont rien demandé.

Quand un **fournisseur** est choisi sur la page ou globalement, sans modèle
explicite sur la page, le modèle hérité des
réglages est ramené au catalogue de ce fournisseur
(`resolveModelForProviderCatalog`) : il peut encore désigner le fournisseur
global, et demander `claude-opus-4-6` à Ollama échoue à l'appel, avec un message
qui parle d'un modèle inconnu plutôt que du choix.

**Le jeu de pages est fermé** (`PAGE_LLM_FEATURES`). Une page y entre le jour où
son runner lit la réponse ; un sélecteur qui promet ce que le runner ignore est
pire que pas de sélecteur. Aujourd'hui : `insights`, `ideation`, `roadmap`,
`github-issues`, `github-prs`, `gitlab-merge-requests`, `prompt-optimizer`,
`natural-language-git`. Les fonctionnalités qui ont un réglage de modèle mais
aucun lecteur (`testGenerator`, `codeReview`, `voiceControl`, `utility`) n'en
font pas partie — le Kanban, lui, a déjà sa formule *par tâche*.

| Qui lit | Où |
|---|---|
| le renderer, pour afficher ce que la page va faire | `resolvePageLlm` (`PageLlmSelector`, `natural-language-git-store`) |
| le main, pour `--model` / `--thinking-level` | `getPageFeatureSettings` (`main/services/page-llm-config.ts`) |
| le main, pour `SELECTED_LLM_PROVIDER` + la clé | `getPageProviderEnv`, puis `credentialManager.getEnvironmentVariables(provider)` |

Les sept `getXxxFeatureSettings()` qui recopiaient la même lecture de
`settings.json` dans autant de handlers sont ce module ; `getRunnerEnv` prend
désormais `{ page }` et ajoute l'environnement du fournisseur de la page. Le
backend n'a rien à apprendre : `core.client._get_active_provider` honore déjà
`SELECTED_LLM_PROVIDER`.

**Le fournisseur reste vide quand personne n'en a choisi** — et non « Claude ».
Le backend a sa propre chaîne de résolution, et y écrire un nom la
court-circuiterait avec une valeur que personne n'a demandée.

**Une surface hors du jeu fermé suit quand même la liste « Fournisseur IA ».**
Le jeu fermé dit quelles pages ont une *formule propre* ; il ne dit pas
lesquelles ont le droit d'ignorer le choix global. `getRunnerEnv()` appelé sans
`page` n'injectait aucun `SELECTED_LLM_PROVIDER` du tout, si bien que la
génération de tests, l'auto-fix GitHub et l'auto-réparation repartaient sur le
défaut du backend pendant que la barre du haut affichait autre chose — le même
symptôme que celui que ce module existe pour corriger, un cran plus bas. Sans
`page`, `getGlobalProviderEnv()` répond : exactement ce qu'une page sans
surcharge reçoit.

Dans l'UI, `PageLlmSelector` vit à gauche de la barre sticky, à côté de la liste
« Fournisseur IA », et n'en est pas un doublon : cette liste dit avec quoi
l'application travaille, celui-ci dit avec quoi *cette page* travaille. Il
n'affiche rien sur une page hors du jeu fermé.

### Qui combat dans le Mode Arena (`shared/utils/arena-contenders.ts`)

Le Mode Arena ne faisait tourner aucun modèle. `runBattle` renvoyait un
paragraphe écrit d'avance par type de tâche, facturait tout le monde à
3 $/million de tokens, et enregistrait chaque participant en
`modelName: "Model A", provider: "unknown"` — si bien que la révélation après
le vote ne révélait rien, que le classement classait des étiquettes, et que la
seule chose que la page existe pour mesurer n'était jamais mesurée. En façade,
la liste des concurrents était quatre noms écrits en dur (`DEMO_PROFILES`),
servis dès que la vraie liste revenait vide — ce qui arrivait toujours, parce
que la vraie liste était `profile:list`, le magasin d'identifiants Claude, qui
ne connaît ni Ollama, ni Copilot, ni Mistral, ni Google.

**Un concurrent est un couple (fournisseur, modèle).** Son `id` est
`fournisseur:modèle`, c'est la clé sous laquelle chaque statistique est classée,
et l'identité voyage avec le participant — masquée par l'UI jusqu'au vote, ce
qui est ce que « à l'aveugle » veut dire : cachée au *lecteur*, connue de
l'enregistrement. L'historique applique la même règle : un combat en attente de
vote n'y affiche pas les noms que l'onglet Combat cache.

**Rien ici ne détecte quoi que ce soit de nouveau.** Deux réponses que
l'application possédait déjà sont jointes : quels fournisseurs sont configurés
(`getStaticProviders`, la source de la liste « Fournisseur IA ») et quels
modèles chacun propose (`fetchProviderModelCatalog`, le catalogue interrogé
auprès du fournisseur lui-même, avec le registre généré en repli). Aucun nom de
fournisseur ni de modèle n'est écrit dans `arena-contenders.ts` ni dans
`useArenaContenders.ts` : un fournisseur ajouté à l'un ou l'autre arrive dans
l'Arena sans qu'on y touche.

| Couche | Répond |
|---|---|
| `shared/utils/arena-contenders.ts` | la liste, la recherche, le couple d'ouverture, l'identité d'un concurrent |
| `renderer/hooks/useArenaContenders.ts` | la jonction des deux sources, et ce qui est injoignable |
| `main/ipc-handlers/arena-handlers.ts` | l'exécution réelle, via `runOneShotLLM` — un contestant, son fournisseur, son modèle |

**Deux modèles locaux sont écartés, pour la même raison : ils ne peuvent pas
gagner un combat, seulement en perdre un sur une erreur.** Celui dont le backend
dit qu'il ne sait pas appeler d'outil, exactement comme le sélecteur de modèles
l'écarte ; et celui qui **n'est pas téléchargé**. Le sélecteur garde ces
derniers comme suggestions parce qu'il sait lancer le `pull` ; l'Arena ne le
sait pas, et y entrer dépense un combat en
`pull model manifest: file does not exist`. Cela règle au passage le cas du
serveur éteint : il répond par le catalogue hors ligne, où rien n'est installé,
donc il ne présente personne au lieu de trente-cinq modèles que la machine n'a
pas.

**Un fournisseur sans adaptateur propre n'entre pas.** mistral, deepseek, grok,
meta, aws, cursor et custom sont servis par le SDK Claude
(`capabilities/providers.yaml`, `degrades_to`) : c'est le bon compromis pour un
build — la tâche tourne — et le mauvais ici, puisqu'une victoire serait
enregistrée au nom d'un éditeur qui n'a jamais vu le prompt. Deux barrières, et
elles ne disent pas la même chose : `oneshot_completion(require_provider=True)`
**refuse** plutôt que de substituer, ce qui est la garantie ; et
`GET /providers/agentic-capabilities` sert cette même matrice au renderer, ce
qui permet de le *dire* dans le sélecteur au lieu de le faire découvrir un
combat plus tard. La matrice est servie et non recopiée en TypeScript : une
seconde copie dériverait le jour où un adaptateur est écrit. Un fetch en échec
laisse tout le monde entrer — vider la page parce que le backend démarre encore
serait pire, et c'est le refus côté backend qui tient la promesse.

**Le couple d'ouverture vient de deux fournisseurs différents** quand c'est
possible. Comparer deux modèles du même éditeur est un combat légitime, mais ce
n'est pas celui qu'on ouvre l'Arena pour lancer, et prendre les deux premiers
d'une liste triée par fournisseur ne donnerait jamais que celui-là.

**Ce qui est affiché est ce qui a été mesuré.** `oneshot_completion` rend
désormais le `last_usage` du fournisseur (`__ONESHOT_USAGE__`), et *seulement*
quand il y en a un : un fournisseur muet ne devient pas
`{"input_tokens": 0, "cost_usd": 0.0}`, parce que dans un classement un zéro
inventé ne se distingue plus d'une mesure. Les tokens tombent alors sur une
estimation, préfixée d'un `~` et dite telle quelle ; le coût, lui, s'affiche
`—`. Un `0` venu d'un modèle local, c'est une vraie réponse et elle s'affiche.
La moyenne du classement ne porte que sur les combats dont le coût a été
rapporté (`costSamples`).

**Les combats de l'ère simulée sont mis de côté, pas comptés.** Ils ne portent
aucune identité résoluble, donc ils ne peuvent pas répondre à la question que
l'onglet Analytics pose, et les compter mettrait un prix inventé à côté d'un
prix mesuré. `readBattles` les déplace une fois vers
`battles.pre-real-models.json` — un enregistrement que personne ne peut
exploiter reste celui de l'utilisateur.

**Une session d'Arena est un vrai appel par modèle.** Le prompt système est le
même pour tous (`TASK_SYSTEM_PROMPTS`, un par type de tâche) : l'Arena mesure le
modèle, donc tout ce qui diffère entre les concurrents est un facteur
confondant. Il est court volontairement — une longue charte maison mesurerait la
capacité à suivre une charte.

### Agent Management (`src/main/agent/`)

The frontend manages agent lifecycle end-to-end:
- **`agent-queue.ts`** — Queue routing, prioritization, spec number locking
- **`agent-process.ts`** — Spawns and manages agent subprocess communication
- **`agent-state.ts`** — Tracks running agent state and status
- **`agent-events.ts`** — Agent lifecycle events and state transitions

### Claude Profile System (`src/main/claude-profile/`)

Multi-profile credential management for switching between Claude accounts:
- **`credential-utils.ts`** — OS credential storage (Keychain/Windows Credential Manager)
- **`token-refresh.ts`** — OAuth token lifecycle and automatic refresh
- **`usage-monitor.ts`** — API usage tracking and rate limiting per profile
- **`profile-scorer.ts`** — Scores profiles by usage and availability

### Terminal System (`src/main/terminal/`)

Full PTY-based terminal integration:
- **`pty-daemon.ts`** / **`pty-manager.ts`** — Background PTY process management
- **`terminal-lifecycle.ts`** — Session creation, cleanup, event handling
- **`claude-integration-handler.ts`** — Claude SDK integration within terminals
- Renderer: xterm.js 6 with WebGL, fit, web-links, serialize addons. Store: `terminal-store.ts`

### Le lien d'un écran d'authentification (`terminal/terminal-interactions.ts`)

Il y a quatre terminaux xterm.js dans le produit — celui des onglets, et un par
écran d'authentification (Claude, Codex/Copilot, GitHub Copilot) — et ils
répondaient différemment à la même question. Le terminal des onglets ouvrait ses
liens par `openExternal` et traitait Ctrl/Cmd+C ; les terminaux
d'authentification chargeaient un `WebLinksAddon` nu et n'écoutaient aucun
raccourci. Ce sont pourtant les seuls écrans où la seule chose à faire est
d'ouvrir une URL, ou de la copier.

Le résultat, sur l'écran de connexion de Claude Code : un clic partait dans
`window.open`, que le processus principal refuse par construction, et Ctrl+C
envoyait un SIGINT au CLI en cours d'authentification au lieu de copier la
sélection. `terminal-interactions.ts` est la seule réponse, chargée par les
quatre :

| Fonction | Répond |
|---|---|
| `createTerminalWebLinksAddon` | un lien cliqué part dans `openExternal` — le seul chemin, celui qui porte les replis Linux |
| `handleClipboardKeyEvent` | Cmd/Ctrl+C (copie s'il y a une sélection, interruption sinon), Ctrl+Shift+C/V, Ctrl+V |
| `attachOsc52Clipboard` | OSC 52, la séquence qu'émet un CLI qui propose lui-même « (c to copy) » — xterm.js ne l'implémente pas, et sans gestionnaire la touche n'a aucun effet observable |
| `readTerminalText` | ce qui est affiché, lignes repliées recollées — lu dans le tampon et non dans le flux, qu'un CLI qui se redessine remplit de versions successives du même écran |

**Et le lien est sorti du terminal.** Une URL OAuth fait trois lignes de
quatre-vingts colonnes : la cliquer suppose de viser le bon fragment, la copier
suppose d'en sélectionner trois dont la césure tombe au milieu d'un `%3A`.
`shared/utils/terminal-links.ts` recolle les fragments — un repli ne laisse ni
blanc ni indentation, et une ligne qui n'atteint pas le bord s'est terminée
d'elle-même — et `TerminalAuthLinkBar` affiche l'URL entière avec de quoi
l'ouvrir et la copier d'un geste.

Le bandeau n'apparaît que quand une URL **de connexion** est affichée
(`oauth`, `authorize`, `login`, `device`…) : la documentation citée trois lignes
plus haut par le même programme n'a rien à y faire, et un bandeau permanent qui
ne dit rien est un bandeau que personne ne lit. Une ligne qui commence par un
schéma n'est jamais la suite de la précédente, sinon deux URL pleine largeur
écrites l'une sous l'autre — ce qu'un CLI qui se redessine produit — n'en
feraient qu'une.

L'échec est dit : `openExternal` rend son rejet jusqu'au bandeau, qui l'affiche.
Un bouton qui ne fait rien et ne dit rien est la pire des deux options, et c'est
ce que `setWindowOpenHandler` produisait en appelant `shell.openExternal`
directement — court-circuitant les replis de `open-external.ts` — avant d'avaler
le rejet.


## Code Quality

### Frontend
- **Linting:** Biome (`pnpm run lint` / `pnpm run lint:fix`)
- **Type checking:** `pnpm run typecheck` (strict mode)
- **Pre-commit:** Husky + lint-staged runs Biome on staged `.ts/.tsx/.js/.jsx/.json`
- **Testing:** Vitest + React Testing Library + jsdom

### Backend
- **Linting:** Ruff
- **Testing:** pytest (`pytest tests/ -v` (venv: `.venv/bin` on Unix, `.venv/Scripts` on Windows))

## i18n Guidelines

All frontend UI text uses `react-i18next`. Translation files: `apps/frontend/src/shared/i18n/locales/{en,fr}/*.json`

90 namespace files per language. Core namespaces: `common`, `navigation`, `settings`, `dialogs`, `tasks`, `errors`, `onboarding`, `welcome`, `analytics`, `appEmulator`, `arena`, `browserAgent`, `dashboard`, `github`, `gitlab`, `ideation`, `insights`, `kanban`, `learningLoop`, `llm`, `multiRepo`, `pairProgramming`, `pixelOffice`, `roadmap`, `selfHealing`, `streaming`, `terminal`, `testGeneration`, `voiceControl`, and more.

```tsx
import { useTranslation } from 'react-i18next';
const { t } = useTranslation(['navigation', 'common']);

<span>{t('navigation:items.githubPRs')}</span>     // CORRECT
<span>GitHub PRs</span>                             // WRONG

// With interpolation:
<span>{t('errors:task.parseError', { error })}</span>
```

When adding new UI text: add keys to ALL language files, use `namespace:section.key` format.

## Cross-Platform

Supports Windows, macOS, Linux. CI tests all three.

**Platform modules:** `apps/frontend/src/main/platform/` and `apps/backend/core/platform/`

| Function | Purpose |
|----------|---------|
| `isWindows()` / `isMacOS()` / `isLinux()` | OS detection |
| `getPathDelimiter()` | `;` (Win) or `:` (Unix) |
| `findExecutable(name)` | Cross-platform executable lookup |
| `requiresShell(command)` | `.cmd/.bat` shell detection (Win) |

Never hardcode paths. Use `findExecutable()` and `joinPaths()`. See [docs/windows-development.md](windows-development.md) for the Windows-specific notes.

## E2E Testing (Electron MCP)

QA agents can interact with the running Electron app via Chrome DevTools Protocol:

1. Start app: `pnpm run dev:debug` (debug mode for AI self-validation via Electron MCP)
2. Set `ELECTRON_MCP_ENABLED=true` in `.env-files/.env`
3. Run QA: `python run.py --spec 001 --qa`

Tools: `take_screenshot`, `click_by_text`, `fill_input`, `get_page_structure`, `send_keyboard_shortcut`, `eval`. 

## Chrome DevTools MCP

Browser automation via [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) is available for **coder** and **QA** agents. It provides 29 tools for navigation, input, screenshots, debugging, emulation, and network inspection.

**Enable:** Toggle "Chrome DevTools" in project Settings → Agent Tools → MCP Servers, or set `CHROME_DEVTOOLS_MCP_ENABLED=true` in `.env-files/.env`.

**Optional:** Set `CHROME_DEVTOOLS_PORT=9222` to connect to a running Chrome instance (e.g., the app emulator). Without it, agents launch a headless Chrome.

**Key tools:** `navigate_page`, `click`, `fill`, `take_screenshot`, `take_snapshot`, `evaluate_script`, `wait_for`, `emulate`, `list_network_requests`.

**Kanban integration:** The preview button (Monitor icon) is available on tasks in Human Review and AI Review columns, allowing visual validation before PR approval.

## Running the Application

```bash
# CLI only
cd apps/backend && python run.py --spec 001

# Desktop app
pnpm start         # Production build + run
pnpm run dev       # Development mode with HMR

# Project data: .workpilot/specs/ (gitignored)
```

## Integrated Tools

### grepai Integration

Semantic code search tool integrated for enhanced AI agent code exploration:

**Setup:**
```bash
# Start grepai server (Docker or CLI on http://localhost:9000)
cd src/connectors/grepai
python grepai_check.py  # Check integration
```

**Usage in Agents:**
```python
from src.connectors.grepai.client import GrepaiClient

client = GrepaiClient("http://localhost:9000")
results = client.search("user authentication flow", top_k=5)
```

**Features:**
- Natural language code search
- Vector embeddings for semantic matching
- Call graph tracing with `grepai trace`
- JSON output for AI agent integration
- Fallback to standard grep when unavailable

**Files:**
- `src/connectors/grepai/client.py` - Python client
- `src/connectors/grepai/grepai/` - Embedded grepai tool
- `src/connectors/grepai/README.md` - Integration guide

## Troubleshooting

### Common Issues

**Claude Authentication Problems:**
```bash
# Check profile configuration
cat ~/.claude/profiles.json
# Refresh tokens automatically via UI or:
python -c "from main.claude_profile.token_refresh import refresh_all_tokens; refresh_all_tokens()"
```

**Build Issues Cross-Platform:**
```bash
# Use platform abstraction functions
from core.platform import isWindows, findExecutable, joinPaths

# Never hardcode paths
exe_path = findExecutable("node")  # Works on Win/Mac/Linux
full_path = joinPaths(["src", "components"])  # OS-agnostic
```

**grepai Connection Issues:**
```bash
# Check if grepai is running
curl http://localhost:9000/health
# Start grepai if needed
cd src/connectors/grepai && python grepai_launcher.py
```

**Memory System Issues:**
```bash
# Check Graphiti status
python -c "from integrations.graphiti.client import check_connection; print(check_connection())"
# Enable via environment if needed
export GRAPHITI_ENABLED=true
```

**Performance Issues:**
- Monitor workflow logs: `tail -f logs/workflow.log`
- Reduce concurrent agents in settings

### Getting Help

- Check `logs/workflow.log` for detailed execution traces
- Run `pytest tests/ -v` from the backend venv for test failures
- Check [shared_docs/README.md](../shared_docs/README.md) for system design
