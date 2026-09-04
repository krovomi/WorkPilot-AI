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
  - [Requirement Traceability](#requirement-traceability)
  - [spec-kit projects](#spec-kit-projects)
  - [Memory System (Graphiti)](#memory-system-graphiti)
  - [Skills System](#skills-system)
  - [Memory Search (mem-search)](#memory-search-mem-search)
  - [Library Documentation (libdocs)](#library-documentation-libdocs)
  - [Mobile applications (Android and Apple)](#mobile-applications-android-and-apple)
  - [Declarative Workflows](#declarative-workflows)
  - [Workflow Logger](#workflow-logger)
- [Frontend Development](#frontend-development)
  - [Tech Stack](#tech-stack)
  - [Path Aliases](#path-aliases)
  - [State Management (Zustand)](#state-management-zustand)
  - [Styling](#styling)
  - [IPC Communication](#ipc-communication)
  - [Agent Management](#agent-management)
  - [Claude Profile System](#claude-profile-system)
  - [Terminal System](#terminal-system)
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
    agent_type="coder",          # planner | coder | qa_reviewer | qa_fixer
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
`skills/_proposed/`, and the `observe` phase runs it when hermes is installed.

```bash
python3 scripts/skills_cli.py hermes-ingest --dry-run
```

A candidate carries **no external verification signal**, and that is not a gap to close
later. Hermes's approval gate is a person saying yes to a text; it is not an observation
of a build that used the skill. Counting it as corroboration would manufacture exactly
the evidence `skill_proposer.evaluate` refuses to invent. Hermes proposes from breadth,
WorkPilot decides from evidence, and a person reads one diff. Nothing under
`skills/<pack>/` is modified, and nothing under `~/.hermes` is ever written.

### Memory Search (`mem-search`)

Three-layer progressive retrieval over the memories that already exist — `task_logger`
traces and `learning_loop` patterns — so an agent can ask "have we hit this before?"
without paying for every candidate to discard most of them.

```python
from mem_search import search_for

memory = search_for(project_dir)
index = memory.index("flaky timeout in the integration suite")  # ~100 tokens, always
memory.timeline(index.ids()[:3])                                # a couple of lines each
memory.detail("task:042-add-widget")                            # the full record, by id
```

The index is held to a token budget by dropping entries and reporting the count, never
by truncating what it kept, and building it never reads a record body — a source that
loaded everything in order to list it would have moved the cost, not removed it.

The agent-facing side is `skills/tooling/mem-search/`. `claude-mem` is declared as an
**optional** pack (`pnpm run skills:bootstrap --pack claude-mem`) rather than installed:
its retrieval pattern is what was worth adopting, and taking the tool itself would add a
fourth memory with its own worker and two more stores.

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
| `brainstorm`, `spec`, `analyze`, `review`, `adversarial-review`, `spec-conformance`, `verify` | the engine (`workflows/runner.py`), as one-shot skill sessions |
| `planning` and `coding` | `run_autonomous_agent`, **driven by the profile** — it decides the dispatch and injects the effort and the declared methodology |
| `design-check` and any deterministic gate | the engine (`workflows/gates.py`) |
| the `tests-pass` hard gate | the engine (`workflows/hard_gates.py`) |
| `qa` | `qa_loop`, which the profile can switch off |
| `observe` | the engine (`learning_loop/observe.py`) |
| `docs` | the preflight (`libdocs.run_preflight`), before planning — no API call, never pruned |

A skill phase runs where the workflow file declares it. The window is looked up
by phase id in the **declared** order, so inserting a phase into
`workflow.yaml` between two existing ones needs no Python change — and pruning
a phase that bounds a window does not hand its work to the neighbouring one.

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
trace_id = workflow_logger.log_agent_start("Claude Code", "refactor_task", {"file": "app.py"})
workflow_logger.log_agent_end("Claude Code", "success", {"changes": 5}, trace_id=trace_id)

# Log skill execution
skill_trace = workflow_logger.log_skill_start("framework-migration", "analyze", {"framework": "react"})
workflow_logger.log_skill_end("framework-migration", "success", {"migrations_found": 3}, trace_id=skill_trace)

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
