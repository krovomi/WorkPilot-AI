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
- **PR Follow-Through** — A task's open GitHub PR is driven to merge: red checks and review threads go to the QA fixer, the commit is checked for weakened tests or CI edits, then pushed (never forced, never merged)
- **Azure DevOps/Jira Integration** — Import work items, sync statuses
- **GenAI Traces** — One OTLP endpoint traces every provider the same way (agent, model calls, tools) with OpenTelemetry GenAI attributes; no prompt or output in the spans, unreported usage marked as estimated
- **OS Sandbox** — An agent's commands run under bubblewrap (Linux) or Seatbelt (macOS): writes confined to the worktree, credentials hidden, network limited to the provider's hosts and the package registries; the card says at launch when they are not isolated
- **Needs You** — Notifications when a task waits for a person, read from the task's state machine, on the desktop, ntfy or Telegram; a waiting plan can be approved from Telegram with a one-shot, expiring button
- **Automations** — A rule turns an event (a GitHub issue labelled, the base branch's CI going red, a time of day) into a Kanban card, a draft by default, one per issue or red streak, under a daily cap; set in a project's settings
- **ACP Agents** — Gemini CLI (and any Agent Client Protocol agent declared in `providers.yaml`) runs a task; its permission questions are answered on the card, refused when outside the agent type's rights, and the sidebar shows only the capabilities the agent declares
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

A view with neither a design file nor a test that names it is marked
**Experimental** (lot M8): the sidebar shows a badge on it and lets the user
hide all of them. The list lives in
`apps/frontend/src/renderer/components/sidebar/experimental-views.ts`; the last
column below marks the same views, and the test fails when the two differ or
when an experimental view has a design file. A view leaves the list when it
gets a design file or a test; none is removed before usage data says which
to keep.

| View | Label | Group | Design | Experimental |
|---|---|---|---|---|
| `dashboard` | Dashboard | Workspace | — |  |
| `kanban` | Kanban Board | Workspace | [kanban-task-types.md](kanban-task-types.md), [frontend-task-panel.md](frontend-task-panel.md) |  |
| `mission-control` | Mission Control | Workspace | — |  |
| `phase35-hub` | Advanced Features | Workspace | — |  |
| `session-history` | Session History | Workspace | — |  |
| `agent-coach` | Personal Agent Coach | Agents | — |  |
| `agent-debugger` | Agent Debugger | Agents | — | yes |
| `agent-replay` | Agent Replay | Agents | — | yes |
| `arena-mode` | Arena Mode | Agents | [arena.md](arena.md) |  |
| `bounty-board` | Bounty Board | Agents | [bounty-board.md](bounty-board.md) |  |
| `consensus-arbiter` | Cross-Agent Consensus Arbiter | Agents | — |  |
| `live-companion` | Live Companion | Agents | — |  |
| `pixel-office` | Pixel Office | Agents | [frontend-architecture.md](frontend-architecture.md) |  |
| `self-healing` | Self-Healing | Agents | — |  |
| `terminals` | Agent Terminals | Agents | [frontend-architecture.md](frontend-architecture.md) |  |
| `code-playground` | Code Playground | Development | — |  |
| `code-review` | Code Review | Development | — |  |
| `cross-language-translation` | Cross-Language Translation | Development | — | yes |
| `documentation` | Documentation | Development | — |  |
| `flaky-tests` | Flaky Test Detective | Development | — |  |
| `onboarding-guide` | Onboarding Guide | Development | — |  |
| `pair-programming` | Pair Programming | Development | — |  |
| `performance-profiler` | Performance Profiler | Development | — | yes |
| `refactoring` | Refactoring | Development | — |  |
| `test-generation` | Test Generation | Development | [test-generation.md](test-generation.md) |  |
| `visual-to-code` | Visual to Code | Development | [visual-to-code.md](visual-to-code.md) |  |
| `architecture-visualizer` | Architecture Visualizer | Explore | [archify.md](archify.md) |  |
| `context-mesh` | Context Mesh | Explore | — |  |
| `context` | Context | Explore | — |  |
| `ideation` | Ideation | Explore | [agent-prompts.md](agent-prompts.md) |  |
| `insights` | Insights | Explore | [agent-prompts.md](agent-prompts.md) |  |
| `learning-loop` | Learning Loop | Explore | — |  |
| `cicd-triggers` | CI/CD Triggers | Git & Integrations | — |  |
| `conflict-predictor` | Conflict Predictor | Git & Integrations | — |  |
| `git-surgeon` | Git History Surgeon | Git & Integrations | — |  |
| `natural-language-git` | Natural Language Git | Git & Integrations | — |  |
| `worktrees` | Worktrees | Git & Integrations | — |  |
| `analytics` | Analytics | Planning | — |  |
| `carbon-profiler` | Carbon / Energy Profiler | Planning | — | yes |
| `changelog` | Changelog | Planning | — | yes |
| `cost-estimator` | Cost Estimator | Planning | — |  |
| `env-snapshot` | Environment Snapshots | Planning | — | yes |
| `release-coordinator` | Release Train Coordinator | Planning | — | yes |
| `roadmap` | Roadmap | Planning | [agent-prompts.md](agent-prompts.md) |  |
| `spec-approval` | Spec Approval | Planning | — | yes |
| `tech-debt` | Tech Debt Dashboard | Planning | — |  |
| `accessibility-agent` | Accessibility Agent | Toolbox | — |  |
| `agent-tools` | MCP Overview | Toolbox | — |  |
| `api-explorer` | API Studio | Toolbox | — |  |
| `api-watcher` | API Contract Watcher | Toolbox | — | yes |
| `app-emulator` | App Emulator | Toolbox | [app-emulator.md](app-emulator.md) |  |
| `blast-radius` | Impact Blast Radius | Toolbox | — | yes |
| `browser-agent` | Browser Agent | Toolbox | — |  |
| `compliance` | Compliance Evidence Collector | Toolbox | — | yes |
| `context-aware-snippets` | Context-Aware Snippets | Toolbox | — |  |
| `dependency-sentinel` | Dependency Sentinel | Toolbox | — |  |
| `doc-drift` | Documentation Drift Detector | Toolbox | — | yes |
| `guardrails` | Agent Guardrails | Toolbox | — |  |
| `i18n-agent` | i18n Agent | Toolbox | — |  |
| `injection-guard` | Injection Guard | Toolbox | — |  |
| `mcp-marketplace` | MCP Marketplace | Toolbox | — | yes |
| `migration` | Code Migration | Toolbox | — |  |
| `notebook-agent` | Notebook Agent | Toolbox | — | yes |
| `offline-mode` | Offline Mode | Toolbox | [offline-mode.md](offline-mode.md) |  |
| `onboarding-agent` | Onboarding Agent | Toolbox | — |  |
| `pipeline-generator` | Pipeline Generator | Toolbox | — | yes |
| `plugin-marketplace` | Plugin Marketplace | Toolbox | — | yes |
| `prompt-optimizer` | Prompt Optimizer | Toolbox | — |  |
| `regression-guardian` | Regression Guardian | Toolbox | — | yes |
| `sandbox` | Agent Simulation Sandbox | Toolbox | — |  |
| `spec-refinement` | Incremental Spec Refinement | Toolbox | — | yes |
| `team-bot` | Team Bot (Slack/Teams) | Toolbox | — | yes |
| `voice-control` | Voice Control | Toolbox | — |  |
| `administration` | Administration | Administration, in server mode for an administrator | — |  |
| `github-issues` | GitHub Issues | Git & Integrations, when GitHub is enabled | — |  |
| `github-prs` | GitHub Pull Requests | Git & Integrations, when GitHub is enabled | — |  |
| `gitlab-issues` | GitLab Issues | Git & Integrations, when GitLab is enabled | — |  |
| `gitlab-merge-requests` | GitLab Merge Requests | Git & Integrations, when GitLab is enabled | — |  |
