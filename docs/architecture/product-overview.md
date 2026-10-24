# Product overview

> Design rationale moved verbatim out of [`docs/CLAUDE.md`](../CLAUDE.md),
> which stays the normative file: where the two disagree, `docs/CLAUDE.md` wins.

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
- **Memory System** — one Obsidian vault (the shared brain) keeps what every build learns, read by every agent
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

## Views

Every view the app can show, one row each: the `SidebarView` identifier
(`apps/frontend/src/renderer/components/Sidebar.tsx`), the English label, the
sidebar group, and the file of this folder that explains its design when one
exists. `tests/test_product_overview_views.py` fails on a view without a row
and on a row without a view. The last five rows are added to the sidebar only
when their integration is enabled, or, for the administration console, in
server mode for someone allowed to administer.

A view without a design file and without a test is one lot M8 decides on:
document and test it, put it behind the experimental flag, or remove it.

| View | Label | Group | Design |
|---|---|---|---|
| `dashboard` | Dashboard | Workspace | — |
| `kanban` | Kanban Board | Workspace | [kanban-task-types.md](kanban-task-types.md), [frontend-task-panel.md](frontend-task-panel.md) |
| `mission-control` | Mission Control | Workspace | — |
| `phase35-hub` | Advanced Features | Workspace | — |
| `session-history` | Session History | Workspace | — |
| `agent-coach` | Personal Agent Coach | Agents | — |
| `agent-debugger` | Agent Debugger | Agents | — |
| `agent-replay` | Agent Replay | Agents | — |
| `arena-mode` | Arena Mode | Agents | [arena.md](arena.md) |
| `bounty-board` | Bounty Board | Agents | [bounty-board.md](bounty-board.md) |
| `consensus-arbiter` | Cross-Agent Consensus Arbiter | Agents | — |
| `live-companion` | Live Companion | Agents | — |
| `pixel-office` | Pixel Office | Agents | [frontend-architecture.md](frontend-architecture.md) |
| `self-healing` | Self-Healing | Agents | — |
| `terminals` | Agent Terminals | Agents | [frontend-architecture.md](frontend-architecture.md) |
| `code-playground` | Code Playground | Development | — |
| `code-review` | Code Review | Development | — |
| `cross-language-translation` | Cross-Language Translation | Development | — |
| `documentation` | Documentation | Development | — |
| `flaky-tests` | Flaky Test Detective | Development | — |
| `onboarding-guide` | Onboarding Guide | Development | — |
| `pair-programming` | Pair Programming | Development | — |
| `performance-profiler` | Performance Profiler | Development | — |
| `refactoring` | Refactoring | Development | — |
| `test-generation` | Test Generation | Development | [test-generation.md](test-generation.md) |
| `visual-to-code` | Visual to Code | Development | [visual-to-code.md](visual-to-code.md) |
| `architecture-visualizer` | Architecture Visualizer | Explore | [archify.md](archify.md) |
| `context-mesh` | Context Mesh | Explore | — |
| `context` | Context | Explore | — |
| `ideation` | Ideation | Explore | [agent-prompts.md](agent-prompts.md) |
| `insights` | Insights | Explore | [agent-prompts.md](agent-prompts.md) |
| `learning-loop` | Learning Loop | Explore | — |
| `cicd-triggers` | CI/CD Triggers | Git & Integrations | — |
| `conflict-predictor` | Conflict Predictor | Git & Integrations | — |
| `git-surgeon` | Git History Surgeon | Git & Integrations | — |
| `natural-language-git` | Natural Language Git | Git & Integrations | — |
| `worktrees` | Worktrees | Git & Integrations | — |
| `analytics` | Analytics | Planning | — |
| `carbon-profiler` | Carbon / Energy Profiler | Planning | — |
| `changelog` | Changelog | Planning | — |
| `cost-estimator` | Cost Estimator | Planning | — |
| `env-snapshot` | Environment Snapshots | Planning | — |
| `release-coordinator` | Release Train Coordinator | Planning | — |
| `roadmap` | Roadmap | Planning | [agent-prompts.md](agent-prompts.md) |
| `spec-approval` | Spec Approval | Planning | — |
| `tech-debt` | Tech Debt Dashboard | Planning | — |
| `accessibility-agent` | Accessibility Agent | Toolbox | — |
| `agent-tools` | MCP Overview | Toolbox | — |
| `api-explorer` | API Studio | Toolbox | — |
| `api-watcher` | API Contract Watcher | Toolbox | — |
| `app-emulator` | App Emulator | Toolbox | [app-emulator.md](app-emulator.md) |
| `blast-radius` | Impact Blast Radius | Toolbox | — |
| `browser-agent` | Browser Agent | Toolbox | — |
| `compliance` | Compliance Evidence Collector | Toolbox | — |
| `context-aware-snippets` | Context-Aware Snippets | Toolbox | — |
| `dependency-sentinel` | Dependency Sentinel | Toolbox | — |
| `doc-drift` | Documentation Drift Detector | Toolbox | — |
| `guardrails` | Agent Guardrails | Toolbox | — |
| `i18n-agent` | i18n Agent | Toolbox | — |
| `injection-guard` | Injection Guard | Toolbox | — |
| `mcp-marketplace` | MCP Marketplace | Toolbox | — |
| `migration` | Code Migration | Toolbox | — |
| `notebook-agent` | Notebook Agent | Toolbox | — |
| `offline-mode` | Offline Mode | Toolbox | [offline-mode.md](offline-mode.md) |
| `onboarding-agent` | Onboarding Agent | Toolbox | — |
| `pipeline-generator` | Pipeline Generator | Toolbox | — |
| `plugin-marketplace` | Plugin Marketplace | Toolbox | — |
| `prompt-optimizer` | Prompt Optimizer | Toolbox | — |
| `regression-guardian` | Regression Guardian | Toolbox | — |
| `sandbox` | Agent Simulation Sandbox | Toolbox | — |
| `spec-refinement` | Incremental Spec Refinement | Toolbox | — |
| `team-bot` | Team Bot (Slack/Teams) | Toolbox | — |
| `voice-control` | Voice Control | Toolbox | — |
| `administration` | Administration | Administration, in server mode for an administrator | — |
| `github-issues` | GitHub Issues | Git & Integrations, when GitHub is enabled | — |
| `github-prs` | GitHub Pull Requests | Git & Integrations, when GitHub is enabled | — |
| `gitlab-issues` | GitLab Issues | Git & Integrations, when GitLab is enabled | — |
| `gitlab-merge-requests` | GitLab Merge Requests | Git & Integrations, when GitLab is enabled | — |
