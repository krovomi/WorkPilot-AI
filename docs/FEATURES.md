# WorkPilot AI features

Every feature of the app, by area. The [README](../README.md) gives the short tour with
screenshots; the design of each feature is in [`architecture/`](architecture/).

> _(experimental)_ marks a view that has neither a design document nor a test yet: the sidebar shows it with a flask badge, and one button hides them all. The list is kept in `apps/frontend/src/renderer/components/sidebar/experimental-views.ts`.

## Autonomous Development Pipeline

| Feature | Description |
|---------|-------------|
| **Kanban Board** | Visual task management from planning through completion with real-time agent progress |
| **Multi-Agent Pipeline** | Planner → Coder → QA Reviewer → QA Fixer pipeline runs autonomously end-to-end |
| **Parallel Execution** | Up to 12 simultaneous agent terminals for parallel builds |
| **Isolated Workspaces** | Every task runs in a dedicated git worktree — your main branch stays safe |
| **AI-Powered Merge** | Semantic conflict resolution when integrating worktrees back to main |
| **QA Auto-Fix Loop** | Agents automatically detect, fix, and revalidate failing acceptance criteria |
| **Runtime Verification** | After QA, the `verify` phase launches the app the task changed, reads every error, fixes and relaunches, drives the app to the state the task asked for and keeps a proof: web and Electron apps through Chrome DevTools, mobile apps on an emulator, APIs through their OpenAPI schema, and WPF, WinForms or WinUI apps through Windows UI Automation, in the one window the card names and never by simulated keystrokes. A card can also list, in plain language, the steps that prove a web change: the verifier follows them in Playwright, captures each step and attaches the Playwright trace to the card; a step not carried out is never a pass |
| **Spec Approval Workflow** | Review and approve AI-generated specifications before implementation begins |
| **Dry Run (plan rehearsal)** | Before a build spends a token, the plan of a spec is replayed over the files of its base branch: a file modified before anything creates it, a path outside the project, a `dotnet test` without a project file or an `npm run e2e` without that script, an API call the OpenAPI contract does not declare. Free, offline, the same for every provider and stack; the uncommitted-changes preview is the second tab. See [docs/architecture/plan-rehearsal.md](architecture/plan-rehearsal.md) |
| **Hot-Swap LLM** | Change provider, model, or reasoning effort mid-task — the next turn resumes on the new engine with context replayed |
| **Honest Effort** | Each provider gets the effort level on its own scale (Claude, OpenAI/Codex, Gemini, Grok, DeepSeek, Mistral, Copilot, Ollama, pi, Antigravity); the picker and the task log say what the model actually receives, and a model that refuses the setting runs on without it instead of failing the phase |
| **Pause & Resume** | Suspend a running task and resume later with full context preserved, optionally on a different provider |
| **Per-Phase Re-run** | Redo any phase (planning, coding, validation) on demand without restarting the whole task |
| **PR-First Review Flow** | Guided human-review with a DoD checklist, "approve & close", and reversible task abandon |
| **PR Follow-Through** | Once the task's PR is open, the card keeps driving it: a red check or an unresolved review thread goes to the QA fixer in the task's worktree, the commit is checked (no test skipped or deleted, no CI file edited) and pushed — never forced, never merged. A failure that is also red on the base branch is reported, not "fixed". GitHub for now — see [docs/architecture/pr-followup.md](architecture/pr-followup.md) |
| **GenAI Traces for Every Provider** | Set one OTLP endpoint and every provider's sessions show up the same way in Jaeger, Langfuse or Phoenix: an agent span, its model calls with token counts, its tool calls. No prompt or output leaves; a provider that reports no usage is marked "estimated", never counted as zero |
| **OS Sandbox** | An agent's commands run under bubblewrap (Linux) or Seatbelt (macOS): writes stay in the task's worktree, your SSH keys and tokens are hidden, the network is the provider's hosts and the package registries through a filtering proxy. When the machine has no sandbox the card says so at launch; `WORKPILOT_SANDBOX=required` refuses to start instead. Windows is not covered yet — see [docs/architecture/os-sandbox.md](architecture/os-sandbox.md) |
| **MCP 2026: Tasks and MCP Apps** | WorkPilot's own MCP servers speak MCP 2026-07-28 and still answer older clients as before. `verify_launch`, `verify_perf_trace` and `verify_device` come back as tasks to a client that reads them: polled, cancelled when the build stops, timed out. A tool of an installed MCP server that attaches a view shows it in the task panel, on every provider including Claude, in an iframe sandboxed without `allow-same-origin` and with the view's own CSP. The view shows the call that happened and cannot act on the task. See [docs/architecture/mcp-2026.md](architecture/mcp-2026.md) |
| **Best-of-N** | Build one task 2 to 4 times, each in its own worktree with its own provider, model and effort; the card ranks them on numbers (finished build, QA, goal, diff size, cost) and you keep the one you choose. Nothing is merged on its own |
| **Goal Mode** | A task is done when a command says so (`dotnet test` exits 0), not when a reviewer thinks so: QA keeps fixing within a pass and spending cap, and the tests it must pass are protected from edits |
| **Spec by Example (.NET)** | On an ASP.NET Core Web API, when the project turns it on, the spec's acceptance criteria are written as HTTP integration tests (`WebApplicationFactory`) before any code. WorkPilot checks they touch only the test project, compile and fail, then makes `dotnet test` the task's goal with those tests protected. A goal you set yourself is kept. See [docs/architecture/spec-by-example.md](architecture/spec-by-example.md) |
| **.NET Upgrades, One Release at a Time** | A Kanban task that names .NET 9, 10 or 11 (or C# 13, 14, 15) gets the .NET team's migration procedures, reviewed and completed up to .NET 11 RC2, for each step between the project's version and the one asked, in order: the planner plans one step per version and QA checks the target. `/migrate-dotnet8-to-dotnet9`, `/migrate-dotnet9-to-dotnet10` and `/migrate-dotnet10-to-dotnet11` appear only in the projects concerned; other stacks pay nothing. See [docs/architecture/dotnet-upgrade.md](architecture/dotnet-upgrade.md) |
| **Cross Review** | After QA, a second engine (another provider and model, chosen per project) reads the diff against the spec and the goal. If it names a blocking problem, the pull request waits for you: fix it, or create it anyway. An answer it cannot read is never taken as approval. See [docs/architecture/cross-review.md](architecture/cross-review.md) |
| **Steering** | Guide the agent while it works, without pausing the task: a message typed in the task's Subtasks tab, the mobile app or the CLI (`--steer`, `--steer-subtask`) goes into the prompt of the next coder or QA fixer session, and the task says which session received it. See [docs/architecture/steering.md](architecture/steering.md) |
| **Guided Review** | The review shows the diff subtask by subtask, each with what it changed and the planner's description as its explanation, then the commits no subtask recorded and what is not committed yet. Out-of-plan files, moved code and QA remarks are flagged on their file; no model is called. Comment any line: open comments go to the fixer with "Request changes" (file, line, excerpt, request), and a comment is marked handled when the diff changed its lines, not when the model says so. See [docs/architecture/guided-review.md](architecture/guided-review.md) and [review-comments.md](architecture/review-comments.md) |
| **Stacked Tasks** | A task waiting on a prerequisite can start from that prerequisite's branch instead of the trunk; its PR shows only its own diff, "Update" rebases it when the prerequisite changes, and once the prerequisite is merged it moves back to the base and retargets its PR (linked as a stack with `gh stack`). See [docs/architecture/stacked-tasks.md](architecture/stacked-tasks.md) |
| **Automatic Split into Small PRs** | After planning, a task whose plan exceeds the review ceiling of its kind (lines a person has to review: 100 for a hotfix, 200 for a bug fix or a version upgrade, 300 for a refactoring, 400 for a feature, tests or docs; generated files and lockfiles count nothing) becomes "Part k/N" cards, one small PR each. Independent parts start in parallel; a dependent part starts once the one it builds on passed QA, stacked on its branch. When a part's PR is merged (GitHub, GitLab or Azure DevOps) the part is done, the parts stacked on it move to the base branch and the next one starts. The parts of a group share one colour and a written mark on the board, the phone and the forge (PR title prefix, `groupe/<id>` label, a "PR group" section). Ceilings per kind in Project settings, overridable on each task; investigations, spikes and runs are never split. See [docs/architecture/task-split.md](architecture/task-split.md) |
| **Hard Gates After QA** | Once QA approves, `deps-exist` looks up every package the task added on its public registry (npm, PyPI, NuGet, Maven, Cargo, Go, Composer, pub, RubyGems) so an invented name never ships (slopsquatting); `tests-bite` plants simple faults in the lines the task wrote and sends a fault the tests miss back to the fixer, on every stack; `proof-checks` runs the project's Dafny, Lean, Verus or F* verifiers. A checker that cannot answer says "unknown", never green. See [docs/architecture/dependency-guard.md](architecture/dependency-guard.md), [mutation-gate.md](architecture/mutation-gate.md), [proof-checks.md](architecture/proof-checks.md) |
| **Red Team** | After QA approves a complex task, a red team agent tries to break what it built: malformed inputs, edge cases, prompt injection on code that calls a model, concurrency, past bugs. It writes attack tests in the project's own framework (any stack) in a throwaway copy, and WorkPilot runs them itself. An unhandled error escaping the changed code sends the fixer back; a different answer is shown on the task's Quality tab, never blocking; a failure that does not repeat is dropped. Later QA passes replay the same attacks without a model; "Attack" on the card runs a fresh one. See [docs/architecture/red-team.md](architecture/red-team.md) |
| **Guardrails as Code** | A versioned `workpilot.policy.yaml` (plus a global and a per-project layer that cannot weaken it) says what agents may not do, checked before each write or command on every provider and in every task worktree: a path (`**/migrations/**`), a branch, content added, a new file over N lines, a test deleted or a dependency added (all stacks). `warn` lets it through and logs it, `deny` refuses, `require_approval` waits for your one-time approval in Settings → Guardrails, which also shows the layers read, recent activity and a dry run of the repository's changes. An invalid policy refuses everything until fixed. See [docs/architecture/guardrails.md](architecture/guardrails.md) |
| **Worktree Recipe** | Each new task worktree is prepared before the first session for its stack (`npm ci`/pnpm/yarn/bun, `dotnet restore`, `uv sync`, poetry, pip, `go mod download`, `cargo fetch`, composer, bundler, `flutter pub get`, Gradle, Maven). `.workpilot/worktree.toml` adds your own steps, ignored files to copy (`.env.local`), a port block per task and a teardown; a written recipe runs only once you approved it as it is. See [docs/architecture/worktree-recipe.md](architecture/worktree-recipe.md) |
| **Tool Result Guard** | Every tool result an agent reads (a file, a page, a command's output, an MCP answer) is scanned for prompt injection before the model sees it, on the WorkPilot loop providers and on Claude, in eight languages (English, French, Spanish, German, Italian, Portuguese, Chinese, Japanese). A suspect result is passed on fenced behind a warning; with `WORKPILOT_TOOL_RESULT_GUARD=block` a blocked one is withheld. The Injection Guard page lists what was flagged in each task (source only, never the content) and the trusted sources you exempt, such as test fixtures; agents cannot edit that list. CLIs that run their own tools (Codex, Gemini CLI, OpenCode) are not covered. See [docs/architecture/tool-result-guard.md](architecture/tool-result-guard.md) |
| **Mobile Platforms That Fit the Project** | The task form's "Mobile platforms" box names the mobile framework it found in the project (Flutter, React Native/Expo, .NET MAUI, Kotlin Multiplatform, Capacitor, native Android or iOS), monorepos included, and greys out a platform the app does not have. On a project without an app (a .NET Web API, a Go service, a CLI…), ticking Android or iOS warns first, then adds the setup and scaffold tasks to the board |
| **Agent Trace** | Which lines of the PR the AI wrote, and with which model, recorded after each session in the open Agent Trace format (`agent-trace.jsonl`) for every provider; lines you edited between sessions stay yours. The changed-files view shows the AI share per file and the PR body sums it up. No prompt or code is stored. See [docs/architecture/agent-trace.md](architecture/agent-trace.md) |
| **Zero-Downtime Migrations** | After QA, the schema guard reads the migrations the task wrote (EF Core, Django, Alembic, Rails, Laravel, Doctrine, Knex, Sequelize, TypeORM, Ecto, and the SQL of Prisma, Drizzle, Flyway, golang-migrate, Diesel, Supabase) with no model and no database: a dropped or renamed column, a NOT NULL column without default or an edited applied migration is an error; a PostgreSQL lock (index without `CONCURRENTLY`, constraint without `NOT VALID`), a type change or a missing down is a warning, each with the tool's own fix and the expand → migrate → switch → contract plan. Shown on the task's Quality tab; blocking only in `strict` mode or with the hard gate `migration-safe`. See [docs/architecture/schema-guard.md](architecture/schema-guard.md) |
| **Provenance Dossier** | When the PR is created, the task folder gets one dossier: who wrote the code and with which model, the dependencies added and their check, a CycloneDX SBOM of the packages the diff added (every stack), the gates passed and the verification verdict. The PR body sums it up and the compliance scan uses it as evidence. See [docs/architecture/provenance.md](architecture/provenance.md) |
| **Requirement Traceability** | At the end of a build, each `FR-###` requirement of the spec is linked to the files its subtasks wrote and to the tests that cover them, on every stack, and the link stays in the project after the merge. The traceability map flags requirements without a test and requirements of other tasks that touched the same files. See [docs/architecture/requirement-links.md](architecture/requirement-links.md) |
| **Point and Change** | In a task's Emulator tab, "Point" turns on the DevTools element picker: click a button or a card of the page and say what to change. Each element goes to the task as a steering message with its image, its path, its style and the files that probably render it (React, Angular, Vue, Svelte, Blazor, Razor Pages, Twig, Blade, ERB…). No script is added to the page. See [docs/architecture/preview-point.md](architecture/preview-point.md) |
| **Proof Video and Base Comparison** | A verification scenario is filmed (WebM in the Verification tab) and its steps assembled into a short GIF you can attach to the PR. The Verification tab also replays the scenario and the checked calls on the code the task started from, then on the task, and lists what behaves differently: broken or fixed steps, console errors, requests and endpoint statuses. A proof for the reviewer, never a gate. See [docs/architecture/verify.md](architecture/verify.md) |
| **Board over MCP** | The `workpilot-board` MCP server gives Claude Code, Codex, Gemini CLI, GitHub Copilot (CLI and VS Code), Cursor, Claude Desktop, Windsurf or OpenCode the project's Kanban: list and read cards and their specs, add one to the backlog, fix a card's text before it starts, wait until a card is ready for your review, read the roadmap and Ideation's ideas (also as MCP resources). Add it to each app in one click from Project settings → Use from other apps. In server mode, the same tools reach the team's boards over HTTP (`<server>/mcp`) with a personal access token made in Settings → MCP access to the server. Starting a build, approving a plan and merging stay with you, on the card. See [docs/architecture/board-mcp.md](architecture/board-mcp.md) |
| **Needs You** | When a task waits for you (plan, review, QA hand-over, error), you hear about it on the desktop and, if you want, on ntfy or Telegram; a waiting plan can be approved from Telegram with a one-shot button. With `WORKPILOT_TASK_DIGEST_HOURS`, a long build also sends a periodic digest (subtasks done, what runs, what is blocked and why) to the notification channels you configured. See [docs/architecture/task-digest.md](architecture/task-digest.md) |
| **Automations** | A rule turns an event into a Kanban card: a GitHub issue labelled, the base branch's CI going red, a time of day, a production incident (Sentry, or a payload dropped in `.workpilot/incidents/`). Cards are drafts by default, one per issue or red streak, under a daily cap; a rule never merges, pushes or comments. A PR opened by someone else gets the AI review instead, kept as an unposted draft in GitHub PRs until you post it |
| **ACP Agents** | Any agent that speaks the Agent Client Protocol runs a task from one entry in `capabilities/providers.yaml`, Gemini CLI first. A question the agent asks before acting appears on the card with its options; the agent type's tool rights are held by the session mode, by refusing questions outside them, and by stopping a turn that runs an undeclared tool. The sidebar lists only the capabilities the agent declares — see [docs/architecture/acp.md](architecture/acp.md) |
| **Declarative Workflows** | A build is described as phases in `workflows/<name>/workflow.yaml`; the engine resolves them against your effort level, the provider's capabilities, the files the task touches and the task itself (`when: kind == … and complexity == …`). On by default |
| **One Workflow per Task Kind** | A card's kind (`feature`, `bug_fix`, `hotfix`, `investigation`, `run`, `refactoring`, `upgrade`, `test`, `docs`, `spike`) is decided without a model from its category, imported item type or wording, shown and editable on the card, and picks the workflow that runs: a bug is reproduced before it is fixed, an investigation writes a report and no code, a RUN writes a procedure a person reads first, then plays it with Python behind the command allowlist, pausing before anything irreversible. Every implementation a workflow names resolves on a fresh clone, on every provider |
| **Optional Methodologies by `fallback:`** | A phase may name a methodology that needs a runtime in the target project (BMAD's `_bmad/`) and a WorkPilot fallback; the engine substitutes the fallback when the runtime is absent and shows it in the profile. Nothing is skipped in silence |
| **Resolved Profile Preview** | See which phases your effort setting bought — and what the next level up would add — in the task detail modal, *before* the build starts |

## Multi-Agent Orchestration

| Feature | Description |
|---------|-------------|
| **Mission Control** | NASA-style dashboard for orchestrating multiple agents simultaneously — live status, token consumption, file changes, and per-agent reasoning |
| **Agent Replay & Debug** _(experimental)_ | Step-by-step replay of any agent session with timeline navigation, file diffs, breakpoints, and token heatmaps |
| **Decision Logger** | Real-time visualization of agent decision trees and trade-off rationale |
| **Consensus Arbiter** | Reconciles conflicting opinions from security scans and QA reviewers into a single verdict |
| **Agent Coach** | Analyzes real usage to suggest cheaper models, better effort levels, and prompt tweaks per agent |
| **Pair Programming** | Interactive real-time AI coding partner with live suggestions and conversation-driven development |
| **Learning Mode** | Educational mode with step-by-step explanations of agent decisions |

## Specialized Agents

| Agent | Role |
|-------|------|
| **Planner** | Complexity assessment, phased subtask breakdown, dependency analysis |
| **Coder** | Context-aware implementation with parallel subagent spawning |
| **QA Reviewer / Fixer** | Acceptance criteria validation and automated issue resolution |
| **Test Generator** | A studio laid out like Visual to Code: the target on the left, the four steps of the run in the middle (live state, click one to open its result), the tests written live on the right. Coverage gaps, unit tests per file, E2E scenarios and TDD in 14 languages plus the project's own; the framework is read from the manifests of the file's language (a C# project with a `package.json` gets xUnit, not Vitest), and a gap becomes tests in one click |
| **Flaky Test Detective** | Runs your test suite several times (dotnet test, pytest, Vitest, Jest, Maven, Gradle, Go) and flags the tests whose result changes between runs; also reads existing JUnit XML and .NET TRX reports |
| **Accessibility Agent** | WCAG 2.2 checks read the same way in every stack (HTML, JSX/TSX, Vue, Svelte, Astro, Angular, Razor/Blazor, PHP/Blade, Twig, ERB, Handlebars) and in the stylesheets: text alternatives, labels, names, headings, keyboard, ARIA, captions, focus, contrast (design tokens mapped in `.workpilot/a11y-tokens.json`), target size. A 0-100 score per criterion and page with its history, a dynamic scan of the running app (App Emulator or localhost: Tab order, accessibility tree, rendered contrast, modal focus), one-click fixes made on a review card, HTML/CSV/PDF export |
| **Refactorer** | Safe code refactoring with pattern detection and API migration |
| **Documenter (Docs and drift)** | Measures the project's documentation coverage per language, lists the files to document first, proposes doc comments in each language's own convention (XML doc, KDoc, rustdoc, godoc, Swift, JSDoc, docstrings…) and folder READMEs, and the drift detector shows where the docs no longer match the code: doc comments naming parameters the code no longer takes, code examples importing or calling what is gone, cited functions and files, and documents the code moved past since their last commit, with a freshness score per document; simple drifts (a renamed parameter, a moved file) are fixed on a review card, a QA gate and `python -m doc_drift_detector check` warn on a branch's drift. Nothing is written to your files without you |
| **Migration Agent** | Framework and library migration with breaking change detection: the page analyses the project, shows the source stack it found and the plan, then creates a Kanban task that migrates in an isolated worktree |
| **Release Coordinator** _(experimental)_ | Orchestrates release readiness, changelog, and version bumps; finds the services of every stack (.NET, Java and Kotlin, Go, Rust, Dart/Flutter, PHP, Ruby, Elixir, Swift, npm, Python) |
| **Memory Manager** | The shared brain: one Obsidian vault every agent reads and writes, across sessions |

## Integrations

| Platform | Capabilities |
|----------|-------------|
| **GitHub** | Import issues, AI investigation, PR review, batch review wizard, auto-PR creation |
| **GitLab** | Issues and merge request management with AI severity categorization |
| **Azure DevOps** | Work item import, PR review, batch operations — _experimental: the PR details view (file list, diff stats) falls back to placeholder data when the Azure DevOps call fails, see [docs/CONFIGURATION.md](CONFIGURATION.md#mock--stub-behaviors-to-be-aware-of)_ |
| **Linear** | Bulk issue import with team/project filtering |
| **Jira** | Read issues, their details and attachments, and turn them into tasks |
| **MCP Marketplace** | Browse, install, and configure Model Context Protocol servers |
| **Custom MCPs** | Define and host custom MCP servers with local authentication. Each custom server's tools are pinned by the fingerprint of what the model reads: a new tool or a changed description waits for your approval in Agent tools → MCP servers, the old description beside the new one, and a description that reads like a hidden instruction asks for an explicit confirmation. See [docs/architecture/mcp-pins.md](architecture/mcp-pins.md) |
| **Windsurf** | Windsurf IDE integration via Connect protocol |
| **JEV (TypeSafe)** | Optional: a classification before planning and risk/coverage hints before reviews, off by default, per workflow. See [docs/integrations/jev.md](integrations/jev.md) |

## AI Providers & Authentication

| Provider | Auth Method |
|----------|-------------|
| **Anthropic Claude** | Claude Code sign-in (subscription, OAuth), or an API profile: a base URL and its token for an Anthropic-compatible endpoint |
| **OpenAI** | API key, or the signed-in Codex CLI (`OPENAI_AUTH_MODE=codex-cli`) |
| **Google Gemini** | API key (Gemini API), or Gemini CLI through the Agent Client Protocol |
| **Grok / xAI**, **Mistral**, **DeepSeek** | API key |
| **GitHub Copilot** | GitHub sign-in (Copilot subscription) |
| **Windsurf** | API key, or the key of the installed Windsurf IDE |
| **Local models** | Ollama, LM Studio or llama.cpp endpoint, no key |
| **Agent CLIs** | OpenCode, Antigravity and [pi](https://pi.dev) run with their own sign-in. The "CLI Tools" sidebar lists every agent CLI (Claude Code, Codex, Copilot, Gemini CLI, Hermes, OpenCode, Antigravity, pi), installed ones first, and installs or updates each in one click through the channel that owns the copy you run |

Meta, AWS and Cursor can be configured, but they have no agent client of their own yet: their builds run on Claude, and the task says so. What each provider can do (subagents, MCP, sandbox, effort) is declared in [`capabilities/providers.yaml`](../capabilities/providers.yaml); keys and variables are in [docs/CONFIGURATION.md](CONFIGURATION.md#provider-selection-and-endpoints).

**Multi-account switching** — Register multiple profiles per provider. WorkPilot AI automatically switches to an available account when one hits a rate limit.

**Keys stay out of the interface** — Once saved, a key or token shows up masked in every screen. Connection tests run in the app's main process. If you change a profile's base URL, you are asked for its key again: a saved key is only sent to the URL it was saved for.

## Code Intelligence

| Feature | Description |
|---------|-------------|
| **Insights** | AI chat interface for exploring and understanding your codebase with semantic search |
| **Ideation** | Discovers performance bottlenecks, security vulnerabilities, code quality issues, and UI/UX improvements |
| **Architecture Visualizer** | Dependency graphs, module hierarchy, and component relationship diagrams |
| **Performance Profiler** _(experimental)_ | AI-powered bottleneck identification with optimization suggestions |
| **Dependency Sentinel** | Shows what the dependency guard really checks on each task (packages added, their registry, known vulnerabilities), instead of sample data |
| **API Contract Watcher** | Every OpenAPI, GraphQL and protobuf contract of the project compared with the target branch (merge base, no baseline to maintain), each contract file on its own: removed or narrowed means breaking, widened or deprecated means potentially breaking, added means safe. Each breaking change lists the code that calls it (all stacks) and the consumers of `.workpilot/api-consumers.yaml`, whose `contact` (e.g. `@org/team`) goes into the task's PR body. `x-breaking-acknowledged` marks a break as intended. After QA, `WORKPILOT_QA_API_CONTRACT=strict` sends an unacknowledged break back to the fixer; `python -m api_watcher check` and a generated GitHub Actions workflow (oasdiff, buf, graphql-inspector, pinned) refuse it in CI. RAML, WSDL and Thrift are compared as text. See [docs/architecture/api-contract-watcher.md](architecture/api-contract-watcher.md) |
| **Code Review & Refactoring** | Code smells (long method, too many parameters, deep nesting, magic numbers, missing docs, duplication…) and review rules for .NET, Java, Kotlin, Scala, Go, Rust, Swift, PHP, Ruby, Dart, C/C++, TypeScript and Python |
| **Regression Guardian** _(experimental)_ | Writes the regression test of an incident in the framework of the stack concerned (pytest, Jest, Vitest, Mocha, JUnit 5, TestNG, xUnit, NUnit, Go, cargo, PHPUnit, RSpec, Dart, XCTest). With a « production incident » automation, each new incident becomes a bug-fix card: the failing test first, then the fix, in the card's PR |
| **Self-Healing Codebase** | Automatically generates fixes when CI tests fail; integrates with Sentry, Datadog, PagerDuty for production incidents |
| **Technical Debt Tracker** | Continuously scores code health, tracks and ages debt items, and proposes auto-fixes with PRs |
| **Risk Classifier** | Scores code changes by risk level with impact assessment |

## Developer Productivity

| Feature | Description |
|---------|-------------|
| **Guided Onboarding** | Setup Hub checklist plus a step-by-step coachmark tour to configure providers and integrations |
| **Roadmap** | AI-assisted feature planning with prioritization and phased rollout |
| **Changelog** | Auto-generates release notes from completed tasks |
| **Natural Language Git** | AI-generated semantic commit messages from diffs |
| **Auto-Refactoring** | Pattern-based and architectural code transformations |
| **Code Migration** | Large-scale codebase migrations across frameworks and libraries |
| **Design to Code (Import Design)** | Turns a mockup, a screenshot or a Figma export into components of the project's stack, detected from its manifests: React, Next.js, Vue, Nuxt, Angular, Svelte, Blazor, HTML + CSS, React Native, Flutter, SwiftUI, Jetpack Compose, .NET MAUI, WPF / WinUI or Avalonia. Six visible steps (vision, design tokens, spec, code, visual tests, write); nothing is written into the project before you review it, and an example result shown without an AI answer is flagged as such. See [docs/architecture/visual-to-code.md](architecture/visual-to-code.md) (section Import Design) |
| **Visual to Code** | Draw an architecture as a node graph (services, databases, agents, a mobile app…) on every stack, with your own reusable bricks, a sentence explaining each connection and eight canvas themes; the bricks' descriptions and the interaction texts go into the build spec sent to the agents. Each connection picks its relation from a list fitted to the two blocks and their stacks (gRPC, SignalR, MassTransit, EF Core, AMQP, FCM / APNs…) or typed freely; every pair of blocks is an expected link or refused with its reason and the block to put between them (a reversed arrow flips in one click), incompatible technologies are flagged, and a "Points to watch" panel reviews the whole diagram. See [docs/architecture/visual-to-code.md](architecture/visual-to-code.md) |
| **Pipeline Generator** _(experimental)_ | Generates GitHub Actions, GitLab CI, Azure Pipelines, Bitbucket and CircleCI configurations for the stack it detects (.NET solutions, Java, Go, Rust, PHP, Ruby, Dart/Flutter, Swift, Elixir, Angular, Nuxt, Svelte, NestJS, Express…) |
| **CI/CD Triggers** | Starts a GitHub Actions, GitLab CI, Azure Pipelines or Jenkins pipeline by hand, or on its own when an agent opens a task's PR and when that PR is merged ("Auto-trigger" with "On pull request" / "On merge"). The task's details say which pipeline started, or why it could not; the runs page marks automatic runs with their task |
| **Browser Agent** | Autonomous browser interaction for E2E test generation and visual regression |
| **Arena Mode** | Side-by-side comparison of different AI models on the same task |
| **Voice Assistant** | A shortcut from anywhere (Ctrl+Shift+Space, configurable): say “create a task to…” or “open the feature to draw an architecture”, transcribed locally; a task is created only once you confirm it, locally or on a server project's board. See [docs/architecture/voice-assistant.md](architecture/voice-assistant.md) |
| **Multi-Repo Orchestration** | The Kanban's "Multi-repo" button runs one change across several repositories: WorkPilot orders them (libraries and APIs first), opens one card per repository and starts each once the previous one passed QA, telling it what the earlier repositories changed. See [docs/architecture/multi-repo.md](architecture/multi-repo.md) |
| **Code Playground** | Sandbox environment for testing code snippets in isolation |
| **Prompt Optimizer** | Analyzes and rewrites prompts for better AI output |

## Memory & Context

| Feature | Description |
|---------|-------------|
| **Memory System (shared brain)** | One Obsidian vault + `graph.json`, served over MCP — agents retain insights across sessions |
| **Skills System** | Provider-agnostic [Agent Skills](https://agentskills.io) packs under `.agents/skills/`, served to the Kanban command bar and mirrored per harness (Claude Code, Copilot, Codex, Cursor, Gemini); read natively by hermes and [pi](https://pi.dev) |
| **Memory Search** | Three-layer progressive retrieval over past builds — an index costs ~100 tokens, timelines and full records are fetched only on demand |
| **hermes-agent** | [hermes-agent](https://github.com/NousResearch/hermes-agent) (0.23.0 or later) skills are read from the same `.agents/skills/`; skills it authors arrive as *candidates* for review, never auto-adopted; the vendored hermes pack follows hermes releases, and the Kanban MCP server reports `wait_for_card` progress to it |
| **pi** | [pi](https://pi.dev) reads `AGENTS.md` and `.agents/skills/` natively and joins the shared brain (`~/.pi/agent/mcp.json`); project resources stay behind its own `/trust`, which WorkPilot never grants — see [docs/architecture/pi.md](architecture/pi.md) |
| **Context Management** | Intelligent context building with file relevance ranking and dependency graph analysis |
| **Session History** | Browse and replay past agent sessions with full statistics |

## Analytics & Monitoring

| Feature | Description |
|---------|-------------|
| **Analytics Dashboard** | Token consumption, cost tracking, success rates, and execution time metrics — live SQLite-backed API; falls back to an explicit 503 when the analytics DB is unavailable |
| **Formula Lab** | Pre-flight cost/success estimation per Provider × Model × Effort, calibrated on your real usage history |
| **Repo Bench** | Replays 10 to 20 of your finished cards from the commit before them, once per engine, in isolated copies that do not hold the answer, and judges each build with the tests the card landed with — tests the agent never sees, kept only when they fail before the card and pass after it. The table says which provider × model × effort resolves your project's work, and per kind of card (bug fix, feature…) which engine to use: the cheapest one close to the best measured rate, offered on the card's engine step with its evidence, never applied for you. Formula Lab and the model router read it. See [docs/architecture/repo-bench.md](architecture/repo-bench.md) |
| **Cost Estimator** | Per-task cost calculation with provider comparison and budget alerts |
| **Carbon Profiler** _(experimental)_ | Estimates the energy (kWh) and carbon footprint of your agent runs |
| **Rate Limit Monitor** | Real-time usage tracking with proactive warnings and auto-switching triggers |
| **Workflow Logger** | Structured execution logs with trace IDs for all agents, skills, and hooks |
| **Learning Loop** | Extracts patterns from completed builds and A/B-replays promoted changes, so a suggestion is backed by an observed run rather than a guess. Review comments the PR follow-up fixed and the feedback of rejected plans become rule candidates; once you adopt one, every build follows it |

## Customization

| Feature | Description |
|---------|-------------|
| **7 Color Themes** | Default, Dusk, Lime, Ocean, Retro, Neo, Forest — each with light and dark variants |
| **Custom Theme Editor** | Color picker with live preview, export, and import |
| **Bilingual UI** | Full French and English interface |
| **Command Palette** | Keyboard-driven access to all features with fuzzy search |
| **Plugin Marketplace** | Browse and install community plugins |
| **One UI Charter** | Every module and every Settings page share one design language, taken from Visual to Code: a header with its group as kicker, pill tabs with counters, cards with a coloured rail, a command bar at the bottom with a single primary button, in all themes and both languages. Rules in [docs/architecture/ui-charter.md](architecture/ui-charter.md) |

## Deployment & Team

| Feature | Description |
|---------|-------------|
| **Multi-User Server Mode** | One server for the team, with JWT / Microsoft Entra auth: every feature is shared (board, roadmap, ideation, insights, context, changelog, analyses, GitHub and GitLab views, AI reviews, automations), live for everyone, with organisations isolated from each other, roles and permissions, user groups and admins. Runs execute on the server, each one seeing only its own project. A task token reaches only its card and is revoked when the card ends. Operations guide: [docs/server-operations.md](server-operations.md); design: [docs/architecture/server-mode.md](architecture/server-mode.md) |
| **Team Collaboration** | On a server project, the board shows who is there and opens a team chat (replies, search, `@name` mentions); a card someone took carries their name, and an edit that crosses a teammate's offers both versions instead of overwriting. See [docs/architecture/collaboration.md](architecture/collaboration.md) |
| **Mobile App (iOS & Android)** | The team server in your pocket: shared Kanban, card detail and creation, start, approve or stop runs, approve a plan from its notification, dashboard, Insights, roadmap, ideas, GitHub and GitLab, admin and invitations. See [docs/architecture/mobile-app.md](architecture/mobile-app.md) |
| **Invitation-Only Signup** | Self-service registration gated by admin invitations, with SMTP delivery and rate limiting |
| **Notifications** | "PR ready" alerts on Slack, Microsoft Teams, Discord, Google Chat or a generic JSON webhook, with SSRF hardening |

## Other views
- **Changelog** — Generate release notes from completed tasks
- **Architecture Visualizer** — Interactive dependency and module graphs
- **Agent Replay** _(experimental)_ — Step-by-step session replay with breakpoints and diffs
- **Analytics** — Usage, cost, and performance dashboards
- **Session History** — Every agent session with its phases, tokens and cost
- **Docs and drift** — Documentation coverage per language, doc comments proposed in each language's convention, drift between docs and code
- **Bounty Board** — The same spec built by several provider/model contestants, an impartial judge picks the winner
