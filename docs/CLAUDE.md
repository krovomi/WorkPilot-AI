# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

WorkPilot AI is an autonomous multi-agent coding framework that plans, builds, and validates software for you. It's a monorepo with a Python backend (CLI + agent logic) and an Electron/React frontend (desktop UI).

> **Deep-dive reference:** [Architecture deep dives](../shared_docs/README.md) | [Configuration reference](../shared_docs/CONFIGURATION.md) | **Frontend contributing:** [apps/frontend/CONTRIBUTING.md](../apps/frontend/CONTRIBUTING.md)

## Product Overview

WorkPilot AI is a desktop application (+ CLI) where users describe a goal and AI agents autonomously handle planning, implementation, and QA validation. All work happens in isolated git worktrees so the main branch stays safe.

**Core workflow:** User creates a task → Spec creation pipeline assesses complexity and writes a specification → Planner agent breaks it into subtasks → Coder agent implements (can spawn parallel subagents) → QA reviewer validates → QA fixer resolves issues → User reviews and merges.

The rules in this file are normative. The feature list and the design rationale behind each feature live in [`shared_docs/architecture/`](#design-rationale-shared_docsarchitecture), one file per feature.

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

**An agent has the tools it declares** — `AGENT_CONFIGS[agent_type]["tools"]` is enforced on
every provider: `create_client` and `create_simple_client` pass `undeclared_builtin_tools` as
`disallowed_tools`, `ToolExecutor(agent_type=…)` offers and runs only what the type declares,
and Codex runs `--sandbox read-only` for a type that neither writes nor runs commands. A prompt
that uses a tool its type does not declare fails `tests/test_agent_tool_declarations.py`:
declare the tool, do not lean on the settings file's blanket grants. Only `core/client.py` and
`core/simple_client.py` build `ClaudeAgentOptions`; the simple client has no hooks and refuses a
type declaring `Write`, `Edit` or `Bash`. Outside the SDK, commands, writes and MCP servers pass
the SDK's own checks.

**PR target** — Always target the `develop` branch for PRs to krovomi/WorkPilot-AI, NOT `main`.

## Project Structure

```
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
│   │   ├── integrations/             # linear, github, windsurf_proxy (graphiti/: legacy, no longer a memory)
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
```

## Design rationale (`shared_docs/architecture/`)

Why each feature is built the way it is. Read the file before changing the feature; this file stays the authority on rules.

| Feature | File | What it covers |
|---|---|---|
| Product overview | [product-overview.md](../shared_docs/architecture/product-overview.md) | The full feature list. |
| Agent prompts | [agent-prompts.md](../shared_docs/architecture/agent-prompts.md) | Which prompt in `apps/backend/prompts/` serves which agent. |
| Agent tool rights | [agent-tool-rights.md](../shared_docs/architecture/agent-tool-rights.md) | A declared tool list is a right on both halves: `disallowed_tools` on the SDK, the executor's gate, Codex's sandbox. |
| Spec pipeline | [spec-pipeline.md](../shared_docs/architecture/spec-pipeline.md) | Plan recovery, `FR-###` traceability and `[NEEDS CLARIFICATION]`, spec-kit constitutions. Reshaping a plan never invents a description. |
| Skills | [skills.md](../shared_docs/architecture/skills.md) | `skills/` is the source and `scripts/skills_cli.py` the only writer; frontmatter is read only through `skills_registry.frontmatter.parse_frontmatter`. |
| hermes-agent | [hermes.md](../shared_docs/architecture/hermes.md) | Ingest, triage and adoption of hermes-authored skills, and `SOUL.md`. Nothing grants trust on someone's behalf. |
| Shared brain and memory | [brain.md](../shared_docs/architecture/brain.md) | The one memory: the Obsidian vault, `graph.json`, its MCP server, build memory (`brain/project_memory.py`), `mem-search`. |
| Test generation | [test-generation.md](../shared_docs/architecture/test-generation.md) | Where generated tests are written (`test_generation/layout.py`) and in which libraries. |
| libdocs | [libdocs.md](../shared_docs/architecture/libdocs.md) | Context7 pages for libraries the repository shows no example of, staged before the build. |
| Model catalogues | [model-catalog.md](../shared_docs/architecture/model-catalog.md) | Codex model discovery and the models.dev registry behind the selectors. |
| docintel | [docintel.md](../shared_docs/architecture/docintel.md) | Attachments, diagrams, OCR engines, secret redaction, ADRs, stack traces, ERDs, visual QA. |
| rtk | [rtk.md](../shared_docs/architecture/rtk.md) | Command output condensed for models only, never for output code parses; the allowlist sees through the proxy. |
| watermarks | [watermarks.md](../shared_docs/architecture/watermarks.md) | Invisible characters stripped from generated files in a PreToolUse hook; `old_string` is never touched. |
| ui-ux-pro-max | [uiux.md](../shared_docs/architecture/uiux.md) | Design system and stack rules, only on tasks that touch an interface. |
| archify | [archify.md](../shared_docs/architecture/archify.md) | Architecture maps and per-task deltas; id continuity is the constraint. |
| Mobile applications | [mobile.md](../shared_docs/architecture/mobile.md) | Stack detection, devices, toolchain readiness; iOS builds only on macOS. |
| Verification loop | [verify.md](../shared_docs/architecture/verify.md) | Launch the app, fix errors, confirm the state, measure, keep proof. |
| Bounty Board | [bounty-board.md](../shared_docs/architecture/bounty-board.md) | Contests scored on artifacts; absent evidence renormalises, never scores zero. |
| Declarative workflows | [workflows.md](../shared_docs/architecture/workflows.md) | `workflow.yaml`, effort pruning, windows, rosters, phase handoff; the workflow logger. |
| Pause and resume | [pause-resume.md](../shared_docs/architecture/pause-resume.md) | `core/pause_state.py`, `BuildPaused` / `BuildHalted`, resuming a phase without paying for it twice. |
| Offline mode | [offline-mode.md](../shared_docs/architecture/offline-mode.md) | `airgapStrict` as a barrier, otherwise a default; the strict switch where the barrier shows. |
| Frontend architecture | [frontend-architecture.md](../shared_docs/architecture/frontend-architecture.md) | Stores, background activity and the sidebar, agent management, profiles, terminals, auth links. |
| Task panel | [frontend-task-panel.md](../shared_docs/architecture/frontend-task-panel.md) | Task progress (`shared/progress.ts`), the Overview tab, acceptance criteria, the change graph. |
| Task engine and page LLM | [task-engine.md](../shared_docs/architecture/task-engine.md) | A task owns its provider × LLM × effort per phase; a page resolves its own through `page-llm.ts`. |
| Visual-to-code | [visual-to-code.md](../shared_docs/architecture/visual-to-code.md) | Architecture documents and their on-disk history. |
| App emulator | [app-emulator.md](../shared_docs/architecture/app-emulator.md) | The landing address derived from the diff, the address bar, open-in-browser. |
| Arena mode | [arena.md](../shared_docs/architecture/arena.md) | Real contenders (provider, model) and measured cost. |
| Developer tools | [dev-tools.md](../shared_docs/architecture/dev-tools.md) | Electron MCP E2E, Chrome DevTools MCP, grepai. |
| Troubleshooting | [troubleshooting.md](../shared_docs/architecture/troubleshooting.md) | Common issues and where to look. |

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

### Spec Directory Structure

Each spec in `.workpilot/specs/XXX-name/` contains: `spec.md`, `requirements.json`, `context.json`, `implementation_plan.json`, `qa_report.md`, `QA_FIX_REQUEST.md`

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

## Running the Application

```bash
# CLI only
cd apps/backend && python run.py --spec 001

# Desktop app
pnpm start         # Production build + run
pnpm run dev       # Development mode with HMR

# Project data: .workpilot/specs/ (gitignored)
```
