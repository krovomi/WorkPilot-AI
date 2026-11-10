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
- **Best-of-N** — One task built 2 to 4 ways, one worktree and engine each; ranked on finished build, QA, goal, diff size and cost, and the person keeps one
- **Goal Mode** — A task carries a command and the exit code that means "done"; QA loops until it holds, within a pass and spending cap, and cannot edit the tests it runs
- **Azure DevOps/Jira Integration** — Import work items, sync statuses
- **GenAI Traces** — One OTLP endpoint traces every provider the same way (agent, model calls, tools) with OpenTelemetry GenAI attributes; no prompt or output in the spans, unreported usage marked as estimated
- **OS Sandbox** — An agent's commands run under bubblewrap (Linux) or Seatbelt (macOS): writes confined to the worktree, credentials hidden, network limited to the provider's hosts and the package registries; the card says at launch when they are not isolated
- **MCP 2026: Tasks and MCP Apps** — WorkPilot's MCP servers return long `verify_*` calls as tasks (polled, cancelled, timed out); views that installed MCP servers attach to their tools show in the task panel, sandboxed without `allow-same-origin`
- **Repo Bench** — Finished cards replayed from the commit before them, once per provider × model × effort, in copies that do not hold the answer, and judged by the tests they landed with (calibrated fail-to-pass and pass-to-pass); the table feeds Formula Lab and the model router
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
- **Performance Profiler** — Static performance analysis of the code (rules, no model call)
- **Documentation** — Documentation coverage and templated generation from the code (no model call)
- **Smart Estimation** — Task complexity and effort estimated from the project's build history (statistics, no model call)
- **Test Generation** — Automated test creation for existing code
- **Conflict Predictor** — AI-powered git conflict prediction
- **Arena Mode** — Compare AI model outputs side-by-side
- **MCP Marketplace** — 37 verified MCP servers (GitHub, GitLab, Azure DevOps, Linear, Jira, Notion, Sentry, Playwright, Microsoft Learn, PostgreSQL…), installed into a project and its agents in one click
- **Plugin Marketplace** — 24 ready-made skills (security audit, .NET Clean Architecture, EF Core review, xUnit tests, ADR, user stories…) installed into the project's `.agents/skills`
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
**Experimental** (lot M8): the sidebar puts a small flask on the corner of its
icon (its tooltip says the view is in beta), the page itself opens with a
"Beta feature" banner, and the sidebar lets the user
hide all of them. While a view is in beta, its entry leaves its group for the
**Labo**, the flask at the foot of the menu's rail, which lists every beta page
with one sentence each; the Group column below is where it returns once out of
beta (F181). The list lives in
`apps/frontend/src/renderer/components/sidebar/experimental-views.ts`; the last
column below marks the same views, and the test fails when the two differ or
when an experimental view has a design file. A view leaves the list when it
gets a design file or a test; none is removed before usage data says which
to keep. That data is local: Settings → Debug & Logs counts visits and time per
page since a date it shows, lists the experimental pages never opened, and
exports it all as JSON (`buildViewUsageReport`,
`apps/frontend/src/renderer/stores/view-usage-store.ts`).

Views that answer the same question share one sidebar entry, a **hub**, and
are its tabs (lot R7): the Group column then reads `group › hub`. A hub's
entry opens the tab last used in the session, and a view's own id still opens
it, inside its hub. The hubs are listed in
`apps/frontend/src/renderer/components/sidebar/hubs.ts`; their design is in
[frontend-architecture.md](frontend-architecture.md#sidebar-hubs-sidebarhubsts).

| View | Label | Group | Design | Experimental |
|---|---|---|---|---|
| `dashboard` | Dashboard | Workspace | — |  |
| `kanban` | Kanban Board | Workspace | [kanban-task-types.md](kanban-task-types.md), [frontend-task-panel.md](frontend-task-panel.md) |  |
| `mission-control` | Mission Control | Workspace | — |  |
| `phase35-hub` | Advanced Features | Workspace | — |  |
| `session-history` | Session History | Workspace › Agent history | — |  |
| `agent-coach` | Personal Agent Coach | Agents | [agent-coach.md](agent-coach.md) |  |
| `agent-debugger` | Agent Debugger | Workspace › Agent history | — | yes |
| `agent-replay` | Agent Replay | Workspace › Agent history | — | yes |
| `arena-mode` | Arena Mode | Agents › Arena | [arena.md](arena.md) |  |
| `repo-bench` | Repo bench | Agents | [repo-bench.md](repo-bench.md) |  |
| `bounty-board` | Bounty Board | Agents | [bounty-board.md](bounty-board.md) |  |
| `consensus-arbiter` | Cross-Agent Consensus Arbiter | Agents › Arena | — |  |
| `live-companion` | Live Companion | Agents | — |  |
| `pixel-office` | Pixel Office | Agents | [frontend-architecture.md](frontend-architecture.md) |  |
| `self-healing` | Self-Healing | Agents | — |  |
| `terminals` | Agent Terminals | Agents | [frontend-architecture.md](frontend-architecture.md) |  |
| `code-playground` | Code Playground | Development | — |  |
| `code-review` | Code Review | Development | — |  |
| `cross-language-translation` | Cross-Language Translation | Development | — | yes |
| `documentation` | Documentation | Development › Docs and drift | [docs-and-drift.md](docs-and-drift.md) |  |
| `flaky-tests` | Flaky Test Detective | Development | — |  |
| `onboarding-guide` | Onboarding Guide | Development › Onboarding | — |  |
| `pair-programming` | Pair Programming | Development | — |  |
| `performance-profiler` | Performance Profiler | Development | — | yes |
| `refactoring` | Refactoring | Development › Debt and refactoring | — |  |
| `test-generation` | Test Generation | Development | [test-generation.md](test-generation.md) |  |
| `visual-to-code` | Visual to Code | Development | [visual-to-code.md](visual-to-code.md) |  |
| `architecture-visualizer` | Architecture Visualizer | Explore | [archify.md](archify.md) |  |
| `context-mesh` | Context Mesh | Explore › Project context | — |  |
| `context` | Context | Explore › Project context | — |  |
| `ideation` | Ideation | Explore | [agent-prompts.md](agent-prompts.md) |  |
| `insights` | Insights | Explore | [agent-prompts.md](agent-prompts.md) |  |
| `learning-loop` | Learning Loop | Explore | — |  |
| `cicd-triggers` | CI/CD Triggers | Git & Integrations | — |  |
| `conflict-predictor` | Conflict Predictor | Git & Integrations › Git impact | — |  |
| `git-surgeon` | Git History Surgeon | Git & Integrations › Git history | — |  |
| `natural-language-git` | Natural Language Git | Git & Integrations › Git history | — |  |
| `worktrees` | Worktrees | Git & Integrations | — |  |
| `analytics` | Analytics | Planning | — |  |
| `carbon-profiler` | Carbon / Energy Profiler | Planning | — | yes |
| `changelog` | Changelog | Planning | [changelog.md](changelog.md) |  |
| `cost-estimator` | Cost Estimator | Planning › Costs and estimation | — |  |
| `smart-estimation` | Smart Estimation | Planning › Costs and estimation | — |  |
| `env-snapshot` | Environment Snapshots | Planning | — | yes |
| `release-coordinator` | Release Train Coordinator | Planning | — | yes |
| `roadmap` | Roadmap | Planning | [agent-prompts.md](agent-prompts.md) |  |
| `spec-approval` | Spec Approval | Planning | — |  |
| `tech-debt` | Tech Debt Dashboard | Development › Debt and refactoring | — |  |
| `accessibility-agent` | Accessibility Scan | Toolbox › Accessibility and i18n | — |  |
| `agent-tools` | MCP Overview | Toolbox › MCP tools | — |  |
| `api-explorer` | API Studio | Toolbox › API | — |  |
| `api-watcher` | API Contract Watcher | Toolbox | — | yes |
| `app-emulator` | App Emulator | Toolbox › Automation | [app-emulator.md](app-emulator.md) |  |
| `blast-radius` | Impact Blast Radius | Git & Integrations › Git impact | — | yes |
| `browser-agent` | Browser Agent | Toolbox › Automation | — |  |
| `compliance` | Compliance Evidence Collector | Toolbox | — | yes |
| `context-aware-snippets` | Context-Aware Snippets | Explore › Project context | — |  |
| `dependency-sentinel` | Dependency Sentinel | Toolbox › Quality and security | — |  |
| `doc-drift` | Documentation Drift Detector | Development › Docs and drift | [docs-and-drift.md](docs-and-drift.md) |  |
| `guardrails` | Agent Guardrails | Toolbox › Quality and security | — |  |
| `i18n-agent` | i18n Scan | Toolbox › Accessibility and i18n | — |  |
| `injection-guard` | Injection Guard | Toolbox › Quality and security | — |  |
| `mcp-marketplace` | MCP Marketplace | Toolbox › MCP tools | [marketplaces.md](marketplaces.md) |  |
| `migration` | Code Migration | Toolbox | — |  |
| `notebook-agent` | Notebook Checks | Toolbox | — | yes |
| `offline-mode` | Offline Mode | Toolbox | [offline-mode.md](offline-mode.md) |  |
| `onboarding-agent` | Onboarding Pack | Development › Onboarding | — |  |
| `pipeline-generator` | Pipeline Generator | Toolbox | — | yes |
| `plugin-marketplace` | Plugin Marketplace | Toolbox › MCP tools | [marketplaces.md](marketplaces.md) |  |
| `prompt-optimizer` | Prompt Optimizer | Toolbox | — |  |
| `regression-guardian` | Regression Guardian | Toolbox | — | yes |
| `sandbox` | Dry Run | Toolbox › API | [plan-rehearsal.md](plan-rehearsal.md) |  |
| `team-bot` | Team Bot (Slack/Teams) | Toolbox | — | yes |
| `voice-control` | Voice Assistant | Toolbox | [voice-assistant.md](voice-assistant.md) |  |
| `administration` | Administration | Administration, in server mode for an administrator | — |  |
| `github-issues` | GitHub Issues | Git & Integrations, when GitHub is enabled | — |  |
| `github-prs` | GitHub Pull Requests | Git & Integrations, when GitHub is enabled | — |  |
| `gitlab-issues` | GitLab Issues | Git & Integrations, when GitLab is enabled | — |  |
| `gitlab-merge-requests` | GitLab Merge Requests | Git & Integrations, when GitLab is enabled | — |  |
