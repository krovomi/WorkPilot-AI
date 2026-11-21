# WorkPilot AI

**English** · [Français](README.fr.md)

**Describe what you want built. A chain of AI agents plans it, codes it, tests it and opens the pull request — each task in its own git worktree, on the AI provider you choose.**

[![License](https://img.shields.io/badge/license-AGPL--3.0-green?style=flat-square)](./LICENSE)
[![Release](https://img.shields.io/github/v/release/krovomi/WorkPilot-AI?style=flat-square&label=release)](https://github.com/krovomi/WorkPilot-AI/releases/latest)
[![Discussions](https://img.shields.io/github/discussions/krovomi/WorkPilot-AI?style=flat-square&logo=github&label=discussions)](https://github.com/krovomi/WorkPilot-AI/discussions)
[![Wiki](https://img.shields.io/badge/docs-wiki-blue?style=flat-square&logo=github)](https://github.com/krovomi/WorkPilot-AI/wiki)
[![CI](https://img.shields.io/github/actions/workflow/status/krovomi/WorkPilot-AI/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/krovomi/WorkPilot-AI/actions)

![WorkPilot AI: the Kanban board, with agents planning, coding and reviewing tasks](.github/assets/showcase/kanban.png)

**[Download](#download)** · **[Quick start](#quick-start)** · **[How it works](#how-it-works)** · **[Tour](#a-tour-of-the-app)** · **[Features](#features-at-a-glance)** · **[AI providers](#ai-providers)** · **[Documentation](#documentation)**

WorkPilot AI is a desktop app (Windows, macOS, Linux) with a Python engine, an optional team server and a phone app. It works on any stack: .NET, Java, Kotlin, Go, Rust, Python, Node.js and TypeScript (Angular, React, Vue, Next.js, Nuxt…), PHP, Ruby, Flutter, Swift, WinDev and more.

---

## Download

### Stable Release

<!-- STABLE_VERSION_BADGE -->
[![Stable](https://img.shields.io/badge/stable-1.5.0-blue?style=flat-square)](https://github.com/krovomi/WorkPilot-AI/releases/tag/v1.5.0)
<!-- STABLE_VERSION_BADGE_END -->

<!-- STABLE_DOWNLOADS -->
| Platform | Download |
|----------|----------|
| **Windows** | [WorkPilot-AI-1.5.0-win32-x64.exe](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.5.0/WorkPilot-AI-1.5.0-win32-x64.exe) |
| **macOS (Apple Silicon)** | [WorkPilot-AI-1.5.0-darwin-arm64.dmg](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.5.0/WorkPilot-AI-1.5.0-darwin-arm64.dmg) |
| **macOS (Intel)** | [WorkPilot-AI-1.5.0-darwin-x64.dmg](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.5.0/WorkPilot-AI-1.5.0-darwin-x64.dmg) |
| **Linux** | [WorkPilot-AI-1.5.0-linux-x86_64.AppImage](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.5.0/WorkPilot-AI-1.5.0-linux-x86_64.AppImage) |
| **Linux (Debian)** | [WorkPilot-AI-1.5.0-linux-amd64.deb](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.5.0/WorkPilot-AI-1.5.0-linux-amd64.deb) |
| **Linux (Flatpak)** | [WorkPilot-AI-1.5.0-linux-x86_64.flatpak](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.5.0/WorkPilot-AI-1.5.0-linux-x86_64.flatpak) |
<!-- STABLE_DOWNLOADS_END -->

### Beta Release

> Beta releases may contain bugs and breaking changes. [View all releases](https://github.com/krovomi/WorkPilot-AI/releases)

<!-- BETA_VERSION_BADGE -->
[![Beta](https://img.shields.io/badge/beta-none%20published-lightgrey?style=flat-square)](https://github.com/krovomi/WorkPilot-AI/releases)
<!-- BETA_VERSION_BADGE_END -->

<!-- BETA_DOWNLOADS -->
_No beta build is currently published. The table above is the latest stable release._
<!-- BETA_DOWNLOADS_END -->

> All releases include SHA256 checksums, a CycloneDX SBOM (`workpilot-sbom.cdx.json`) and a build provenance attestation for each file (`gh attestation verify <file> --repo krovomi/WorkPilot-AI`); VirusTotal scan results are added to the release notes when the scan is configured.


---

## Quick start

1. **Install** the app for your platform from the [download table](#download).
2. **Open a project**: any folder that is a git repository.
3. **Connect an AI provider**: a Claude subscription, an API key (OpenAI, Gemini, Grok, Mistral, DeepSeek), GitHub Copilot, a local model (Ollama, LM Studio) or an agent CLI (Codex, OpenCode, pi…).
4. **Create a task** on the Kanban board and describe what you want.
5. **Review the result**: the agents plan, code and validate; you approve the plan if you want to, then review the diff and merge.

From source (Node.js 22.12+, pnpm, Python 3.12+, Git):

```sh
git clone https://github.com/krovomi/WorkPilot-AI.git
cd WorkPilot-AI
pnpm install
pnpm run dev
```

Step-by-step installation, provider setup, Windows notes and troubleshooting: [docs/INSTALLATION.md](docs/INSTALLATION.md) (in French).

---

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/showcase/how-it-works-dark.png">
  <img alt="How it works: plan (you describe a task, spec, planner, you approve), build and check (coder, QA reviewer and QA fixer until QA approves), prove and ship (verify, you review the diff, merge or pull request)" src=".github/assets/showcase/how-it-works-light.png" width="100%">
</picture>

- **Isolated**: every task runs in its own git worktree, so your branch stays untouched until you merge; the worktree is removed once the task's pull request is merged.
- **Reviewed, always**: pages that write code (test studio, Import Design, changelog, pair programming, the Kanban's quick commands) put it on the branch of a « Generated code » card in Human Review; it reaches your project only through a pull request you review ([generated code](docs/architecture/generated-review.md)).
- **One workflow per kind of task**: a bug is reproduced before it is fixed, an investigation writes a report and no code, a refactoring may not touch the tests, a hotfix gets an independent review ([task kinds](docs/architecture/kanban-task-types.md)).
- **Small pull requests**: a task bigger than the review ceiling of its kind splits itself into parts, one small PR each, stacked when they depend on each other ([task split](docs/architecture/task-split.md)).
- **Proof, not opinion**: after QA, the app the task changed is started and driven (web, Electron, mobile emulator, API, Windows desktop), and hard gates check the dependencies added and that the tests really catch faults.
- **Any engine**: change provider, model or effort per task, even mid-task; what each provider can do is declared in [`capabilities/providers.yaml`](capabilities/providers.yaml).

---

## A tour of the app

> Every screenshot comes from the real app, filled with an invented demo project (`acme-storefront`), and is regenerated by [`scripts/readme-screenshots/`](scripts/readme-screenshots/).

**Kanban board** (above): describe a task and follow it from planning to the pull request. Each card shows its phase, its progress, the provider at work and what it is about; the parts of a split task share a colour and a « Part k/N » mark. Columns follow the pipeline: Planning, Queue, In Progress, AI Review, Human Review, Open PR (while a pull request waits to be merged), Done, plus Red Build when the project's CI fails on a task branch. The toolbar holds on one line; its « ⋯ » menu has **Multi-repo** (one change across several repositories) and **Purge** (frees the disk space held by the worktrees of finished cards).

<table>
<tr>
<td width="50%" valign="top">

**Task detail**: the plan split into subtasks with the files each touches, logs, changed files, visual proofs and the emulator.

![Task detail with its subtasks](.github/assets/showcase/task-detail.png)

</td>
<td width="50%" valign="top">

**Agent terminals**: up to 12 terminals side by side, each in a task's worktree, to run agents in parallel by hand.

![Agent terminals: two sessions side by side](.github/assets/showcase/terminals.png)

</td>
</tr>
<tr>
<td valign="top">

**Insights**: ask about your codebase; answers cite files and lines, and a finding becomes a task in one click.

![Insights: a conversation about the codebase that ends in a suggested task](.github/assets/showcase/insights.png)

</td>
<td valign="top">

**Roadmap**: product vision, phases, MoSCoW priorities, competitors and votes; any feature becomes a task with **Build**.

![Roadmap as a Kanban of features](.github/assets/showcase/roadmap.png)

</td>
</tr>
<tr>
<td valign="top">

**Ideation**: agents scan the project and propose improvements by type, each with its rationale and files.

![Ideation: improvement ideas by type](.github/assets/showcase/ideation.png)

</td>
<td valign="top">

**Dashboard**: what the agents produce and cost, by status, provider and model; exportable as JSON or CSV.

![Dashboard of project metrics](.github/assets/showcase/dashboard.png)

</td>
</tr>
<tr>
<td valign="top">

**Visual to Code**: draw the architecture as a node graph, each connection explained and checked, then generate the project.

![Visual to Code: an architecture drawn as a node graph, every connection explained](.github/assets/showcase/visual-to-code.png)

</td>
<td valign="top">

**Import Design**: a mockup, screenshot or Figma export becomes components of the project's stack, in six visible steps.
The code is then rendered, compared with the mockup and corrected until it matches, within the iterations, threshold and token or cost budget you pick, with each iteration's score and the remaining differences shown; on request, the version kept is also checked at mobile, tablet and desktop widths and in its hover and focus states ([render loop](docs/architecture/design-render-loop.md)).

![Import Design: the six steps from an image to the project's components](.github/assets/showcase/import-design.png)

</td>
</tr>
<tr>
<td valign="top">

**Test generation studio**: coverage gaps, unit, E2E or TDD, written live in the framework of the file's own stack.

![Test generation studio: target, four-step pipeline and live result](.github/assets/showcase/test-generation.png)

</td>
<td valign="top">

**Settings**: application and project settings grouped by theme, in the same design charter as every module, in the colours of the active theme.

![Settings: grouped navigation and the project's general page](.github/assets/showcase/settings.png)

</td>
</tr>
<tr>
<td valign="top">

**AI accounts**: every provider on one page, with how it signs in, whether it answers, its usage and the age of its key; a task stopped by a limit resumes on the next account of the failover chain, whatever the provider.

![AI accounts: connected providers, default provider and automatic failover](.github/assets/showcase/ai-accounts.png)

</td>
<td valign="top">

**Sandbox**: a snapshot of the task's worktree before each agent session, restored when the anomaly watch stops a session; restricted write mode and limits per session.

![Sandbox settings: snapshots and rollback, write mode, limits per session](.github/assets/showcase/sandbox.png)

</td>
</tr>
<tr>
<td valign="top">

**Code migration**: analyse a framework, version or language migration on any stack, read its phases, steps and risk, then hand the plan to a Kanban task.

![Code migration: React 18 to React 19, the planned phases and the risk](.github/assets/showcase/code-migration.png)

</td>
<td valign="top">

**Your own menu**: drag a page onto another space or reorder your pins, or use « Customize the menu » from the keyboard; the menu is resizable and, on a team server, follows you on every computer.

![Customize the menu: grips and arrows to reorder the pinned pages](.github/assets/showcase/menu-customize.png)

</td>
</tr>
</table>

**Mobile app (iOS and Android)**: with a team server, the shared board in your pocket: open a card, approve a plan, start or stop the agents, read the dashboard, Insights, roadmap and ideas.

![Mobile app: board, card and dashboard](.github/assets/screenshots/mobile.png)

---

## Features at a glance

The full list, with every detail, is in **[docs/FEATURES.md](docs/FEATURES.md)**. Views marked _experimental_ (a flask on their icon) have no design document or test yet; they are gathered in the menu's **Labo**, the flask at the foot of the rail, and one button hides them all.

**Build pipeline**
- **Kanban board** with spec approval, pause and resume, per-phase re-run, steering messages while the agent works, and a guided review with line comments sent back to the fixer; diffs in git colours, with syntax highlighting for every stack, changed words marked and an Auto side-by-side layout.
- **Swarm mode** builds the subtasks a plan allows side by side, each in its own worktree, merged into the task's branch after each wave.
- **Automatic split** of big tasks into small grouped PRs, **stacked tasks**, **Best-of-N** (build a task 2 to 4 times on different engines and keep the best, with an arbiter when the variants do not do the same thing) and **multi-repo** changes, on the provider, model and effort you pick for them.
- **Plan rehearsal** replays a spec's plan over the base branch before the build; after QA, a **red team** agent tries to break what the task built, and the **migration guard** says what the task's migrations would do to a production database, for every stack.
- **Goal mode** (done when a command says so, e.g. `dotnet test` exits 0), **cross review** by a second engine, **spec by example** for ASP.NET Core Web APIs, **.NET upgrades** one release at a time up to .NET 11.
- **Runtime verification** with proof videos and a comparison against the base branch; **hard gates** for invented packages, toothless tests and formal proofs; [REA](docs/architecture/rea.md) reads the build a task leaves, without running it, and reports what it exposes, and on .NET flags a public API the task broke.
- **Device matrix** in the App Emulator: the page shown, rendered on several phones, tablets, desktops and a TV at once (viewport, pixel ratio, user agent, touch), side by side, optionally on a throttled network (4G, Fast 3G, Slow 3G) and a slowed-down CPU, with the classic responsive bugs flagged on each: sideways scrolling, oversized media, touch targets under 44 px, text under 12 px, overlapping elements, cut-off text; the grid exports as a single PNG ([device matrix](docs/architecture/device-matrix.md)).
- **Browser Agent recorder**: drive a page by hand and get a Playwright (TypeScript or Python), Cypress, Selenium (Python or Java) or WebdriverIO test that goes into iframes and shadow roots and waits for what each action caused, with robust selectors, secrets read from environment variables, proposed on a review branch.
- **WinDev, WebDev and WinDev Mobile** projects saved in text format: agents edit only the WLangage code, a QA gate sends back anything only the editor may write, and WLangage is coloured in the diff viewer ([WinDev](docs/architecture/windev.md)).
- **PR follow-through**: a red check or a review thread on the task's PR goes back to the fixer, never forced, never merged.
- **Provenance**: which lines the AI wrote and with which model, an SBOM of the packages added, requirement-to-test traceability.
- **Guardrails as code**: a versioned policy, in layers, that agents cannot get around, enforced in task worktrees too; every tool result is scanned for prompt injection before the agent reads it.
- **Security findings ranked by what runs**: the QA security scan sorts its findings into critical & exposed, critical but dormant, medium and informational, from what your entry points reach (any language) and from the production incidents of the last 30 days in `.workpilot/incidents/` (Sentry, Datadog, CloudWatch, New Relic…); the fixer sees the exposed ones first, and what blocks a build still follows severity.

**Agents and orchestration**
- **Execution waves** (Mission Control): the specs waiting in the backlog are grouped into waves that share no file, from their plans, their worktrees, the files the git history changes together, cross imports and removed symbols, checked by a test merge, then run wave after wave in merge order with the project's parallelism; a run interrupted by a restart can be resumed, and the last 14 days of runs show the conflicts avoided; no model is called.
- **Mission Control auto-compose**: a crew of agents suggested from a description, a task's spec or a session template (bug fix, new feature, refactor, incident), mixing the providers you pick, models filtered by their capabilities, priced by the Cost Intelligence catalog, and a cheaper crew under a budget; while it runs, a stuck agent is moved to another provider or a bigger model, and past sessions calibrate the estimates.
- **Mission Control** to run several agents on one goal, **agent terminals**, **Arena** and **Bounty Board** to compare engines, **Repo bench** to measure them on your own past tasks.
- **Pixel Office** shows your agents as pixel-art characters at their desks, earns achievements from what the project delivers (tasks shipped, QA passed on the first review, incidents resolved, a second engine agreeing) on every provider, and has a **TV mode** for a team screen, with a calm mode that stops the animations.
- **Agent Replay** shares a recorded session: a `.wpreplay` bundle a teammate imports, or one HTML page anyone opens without WorkPilot, with secrets and local folders masked and, on request, the reasoning, the token counts or the file contents left out; bookmarks with a note mark the steps that matter. The page also exports as a WebM video played step by step, and a session whose model left no reasoning gets, on request, a short summary of its steps from the default provider's fast model.
- Specialised agents: test generator, flaky test detective (with the cause and a fix card), refactorer, docs and drift, accessibility (WCAG 2.2 score and fixes), i18n, API contract watcher, compliance evidence, notebooks (cell dependencies, fresh-kernel runs), migration, self-healing on CI failures, technical debt tracker; their fixes go on a review branch, never straight into your folder.
- **Self-healing that looks further than the last commit**: risk trends per file from scan to scan (a hot list of fast-rising files, directories that degrade together), production errors from several monitoring tools grouped into one incident per bug with its suspect commits, and a bisect of a CI failure in a temporary worktree that names the first bad commit to the fixer.
- **Release Train** deploys your services itself, in dependency order, with health and smoke checks and a click per production service; the **Git history surgeon** cleans up a branch's commits onto a new branch, same code.
- **Pair programming with an AI participant**: invite WorkPilot AI into a room; it answers with the provider you picked and proposes code as a suggestion on the room's file, never written; on a team server, `@ia` in the team chat gets an AI reply.
- **Personal coach**: learns your coding style per language from your git history and lint config, and gives your clear preferences to the coder and the QA fixer.
- **Shared memory**: one Obsidian vault and graph every agent reads and writes, across sessions and providers; every memory decision (created, forgotten, restored, pinned, merged) is journalled with its author and reason and can be taken back (the last automatic one within the hour, a merge at any time), forgotten notes stay 30 days in a trash, and a team sync that contradicts a note is flagged, a pair that flip-flops going to the maintainers the team names, and a memory can be scoped to a part of the code ([memory lifecycle](docs/architecture/memory-lifecycle.md)); the learning loop analyses each build with a model of whichever provider is selected, and its lessons reach the spec, the plan, the code and QA; provider-agnostic **skills** packs.
- **Lessons applied, per task**: the task panel lists the adopted rules, learned patterns and kind checkpoints (bug fix, refactoring, upgrade…) each prompt of the task carried, and any one can be turned off for that task alone; a kind's checkpoints reach its spec only when this repository's QA history shows specs of that kind coming back.

**Understand and plan**
- **Insights**, **Ideation**, **Roadmap**, architecture visualizer with architecture drift for every major stack (layers inferred from .NET projects, Maven/Gradle modules, Go, Rust, PHP, Dart and Swift packages), code review rules and code smells for every major stack, risk classifier.
- **Code migration** for frameworks, versions and languages: the plan (phases, steps, risk) is shown, then a Kanban task applies it.
- **Visual to Code**, **Import Design**, **pipeline generator** (GitHub Actions, GitLab CI, Azure Pipelines, Bitbucket, CircleCI) and a **voice assistant** (Ctrl+Shift+Space, a foot pedal on F13–F24, or an optional wake word) that can listen continuously, answer aloud with your system's voices, follow a running task and pass your spoken guidance to its agent, and stop the running agents after their current step when you say “stop”.

**Integrations**
- GitHub, GitLab, Azure DevOps, Jira and Linear: import issues, investigate them, review pull requests.
- **AI PR review that learns**: accept, reject or mark each finding not applicable, with a reason; a kind of remark your project keeps rejecting is downgraded, then no longer raised, on every provider, in follow-up reviews too; security and critical findings never are. A per-project view shows the acceptance rate by category, resets a learned rule and writes `.workpilot/review-conventions.md` ([review feedback](docs/architecture/review-feedback.md)).
- **Automations** turn an event (an issue labelled, CI red, a time of day, a production incident from Sentry) into a draft card; **CI/CD Triggers** start your pipeline (GitHub Actions, GitLab CI, Azure Pipelines, Jenkins) when an agent opens a task's PR or the PR is merged, then **watch the deployment** (health check and Prometheus metrics against their level before it) and offer, or start, a **rollback** to the last run that succeeded; a bad verdict brings an **incident report** (the numbers, then a few sentences from your model), a notification, and on request a **revert PR** of the deployed commit on your forge.
- MCP marketplace and custom MCP servers with pinned tool descriptions; each catalog server shows a **security score** out of 100 (publisher, tool permissions, pinned version, release date, known vulnerabilities from OSV, maintainer changes), installed servers are checked again daily with alerts to acknowledge, and a project can restrict what may be installed (`.workpilot/mcp-policy.json`); the **workpilot-board** MCP server gives Claude Code, Codex, Gemini CLI, Copilot, Cursor and others your Kanban.
- Notifications on Slack, Teams, Discord, Google Chat, webhooks, ntfy and Telegram.

**Team**
- **Server mode**: one server for the team, every feature shared live, organisations isolated, roles, groups and admins, JWT, Microsoft Entra or any OpenID Connect sign-in (Okta, Google, Keycloak...), spec approval by someone other than the card's author, by as many approvers as the card's criticality needs, approvals lent for a holiday ([operations guide](docs/server-operations.md)).
- **Mobile app** for iOS and Android, team chat, invitation-only sign-up.

**Cost and monitoring**
- Cost budgets enforced while tasks run: a project budget per period and a limit per task, checked before every agent session on every provider; the task pauses at its limit, can step down to a lighter model of the same provider, and a task that spends without progress is paused too.
- Circuit breaker and kill switch: an agent that repeats the same tool call with the same result is paused on every provider, and "Stop all agents" (sidebar button, Ctrl+Shift+.) pauses every running task, each resumed from its card.
- Governance in `workpilot.policy.yaml`: allowed hours in an explicit time zone, forbidden and review-required files, an hourly token budget, applied to every agent on every provider; an invalid file refuses everything, and every decision goes to an audit trail exported as CSV or JSON from Settings > Guardrails.
- Smart Estimation that learns each repository: the estimate of a task is corrected by what its merged specs actually cost (cost, tokens, QA iterations, files changed), shown as a range with its confidence and a breakdown by dimension, with your own adjustment and a reset; every provider feeds the same history.
- Analytics dashboard with "How you compare" (a project against its past and your other projects of the same stack and size, per spec, nothing sent anywhere), cost estimator, Formula Lab (cost and success estimate per provider, model and effort), rate-limit monitor with account switching, carbon profiler with a monthly budget and an ESG export, OpenTelemetry GenAI traces for every provider.

**Look and feel**
- One UI charter across every module that follows the active theme: 7 colour themes in light and dark plus a theme editor, full English and French interface.
- A light menu: a rail of spaces with one panel at a time, arranged by each person (drag a page onto another space, reorder pins, or « Customize the menu » from the keyboard) and resizable with the mouse, « My menu » for pinned and recent pages, four Toolbox hubs, the beta pages in a **Labo**, an offer to hide pages unused for 30 days, the CLI tools in one chip; the command palette (Ctrl+K or `/`) finds every page by name, group or keyword.
- A first-run wizard that sets up any AI provider and says honestly which ones are connected.

---

## AI providers

| Provider | Sign-in |
|----------|---------|
| **Anthropic Claude** | Claude Code sign-in (subscription), or an API profile: a base URL and its token |
| **OpenAI** | API key, or the signed-in Codex CLI |
| **Google Gemini** | API key, or Gemini CLI through the Agent Client Protocol |
| **Grok (xAI)**, **Mistral**, **DeepSeek** | API key |
| **GitHub Copilot** | GitHub sign-in (Copilot subscription) |
| **Windsurf** | API key, or the key of the installed Windsurf IDE |
| **Local models** | Ollama, LM Studio or llama.cpp, no key |
| **Agent CLIs** | Codex, OpenCode, Antigravity, pi, Hermes: installed and updated in one click from the **CLI Tools** sidebar |

Several accounts per provider can be registered. With automatic failover on, a task stopped by a rate limit or a lost connection resumes on the next account of the chain you order (Claude accounts, API profiles, Copilot, OpenAI, Mistral, Ollama…), at the phase where it stopped. The usage breakdown names each account's plan as the provider reports it (Claude Pro or Max, ChatGPT Plus or Pro, Copilot…) or says it is billed by API key. Keys are stored in the OS keyring and shown masked; the interface never receives their value. Meta, AWS and Cursor can be configured but have no agent client yet: their builds run on Claude, and the task says so. Variables and defaults: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

---

## Architecture

How the pieces talk to each other:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/showcase/architecture-dark.png">
  <img alt="Architecture: on your machine the desktop app and the Python engine work on your git repository, one worktree per task; the engine talks to AI providers, forges and trackers, and other AI clients; an optional team server shares the board with the mobile app" src=".github/assets/showcase/architecture-light.png" width="100%">
</picture>

Where they live in the repository:

| Folder | What it holds |
|---|---|
| `apps/backend/` | Python agents, specs, QA, local API, server mode |
| `apps/frontend/` | Electron desktop app (React + TypeScript) |
| `apps/mobile/` | iOS and Android app (Expo), client of server mode |
| `src/` | Shared Python connectors (Jira, Azure DevOps…) |
| `capabilities/` | What each provider and harness can do |
| `config/` | Provider list shown in Settings |
| `workflows/` | One declarative workflow per task kind |
| `skills/` | Skill packs (`.agents/skills/` is generated) |
| `deploy/` | Server image and docker-compose |
| `changelog.d/` | One changelog fragment per pull request |
| `docs/` | Rules, design rationale, guides |
| `tests/` | Python tests (frontend tests sit next to the code) |
| `scripts/` | Build, release and maintenance scripts |

How the pieces fit (agents, subagents, workflows, state, security layers): [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (in French). Why each feature is built the way it is: [docs/architecture/](docs/architecture/). A guided, clickable atlas readable without a technical background: [docs/audit/WorkPilot-architecture.html](docs/audit/WorkPilot-architecture.html). Instructions for coding agents start at [`AGENTS.md`](AGENTS.md).

### Command line

```bash
cd apps/backend
python runners/spec_runner.py --interactive   # Create a spec interactively
python run.py --spec 001                      # Run autonomous build
python run.py --spec 001 --review             # Review
python run.py --spec 001 --merge              # Merge
```

Full reference: [docs/CLI-USAGE.md](docs/CLI-USAGE.md).

---

## Security

1. **OS sandbox**: agent commands run under bubblewrap (Linux) or Seatbelt (macOS); Windows is not covered yet, and the card says when a task runs without a sandbox.
2. **Filesystem restrictions**: operations stay inside the project directory.
3. **Dynamic command allowlist**: only the commands of the detected stack are allowed.
4. **Snapshots and trust score**: before each agent session the task's worktree is saved as a hidden git commit; each session starts with a trust score of 100 that anomalies lower, and below a threshold the task pauses, or the session stops and its snapshot is restored. Restricted mode and per-session limits are in Settings > Sandbox; restore a snapshot from the card.

API keys and tokens are encrypted at rest with the OS keyring; Settings > Accounts shows how long ago each API key was saved and suggests renewing it after 90 days. Every release ships SHA256 checksums, a CycloneDX SBOM and a build provenance attestation per file.

To report a vulnerability, follow [docs/SECURITY.md](docs/SECURITY.md), never a public issue. The rules contributors and coding agents follow are in [docs/rules/security.md](docs/rules/security.md).

---

## Documentation

| Document | What it covers |
|----------|----------------|
| [Features](docs/FEATURES.md) | Every feature, by area |
| [Installation](docs/INSTALLATION.md) | Requirements, install methods, provider setup, Windows notes, troubleshooting (in French) |
| [Configuration](docs/CONFIGURATION.md) | Provider registry, credential resolution, environment variables |
| [CLI usage](docs/CLI-USAGE.md) | Headless and CI usage |
| [Architecture](docs/ARCHITECTURE.md) | Agents, workflows, state and security layers (in French) |
| [Design rationale](docs/architecture/) | Why each feature is built the way it is, one file per feature |
| [Server operations](docs/server-operations.md) | Running the team server: deployment, TLS, backups, upgrades, quotas (in French) |
| [Linux](docs/linux.md) · [Windows development](docs/windows-development.md) | Platform notes |
| [Contributing](docs/CONTRIBUTING.md) | Development setup, code style, tests, pull requests |
| [Release process](docs/RELEASE.md) | How releases are cut and published |
| [Security policy](docs/SECURITY.md) | Supported versions, reporting a vulnerability |
| [Documentation map](docs/README.md) | Where every document lives and what it is for |
| [Wiki](https://github.com/krovomi/WorkPilot-AI/wiki) | User guides, refreshed after each release |

---

## Contributing and community

Contributions are welcome: start with [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). Pull requests target `develop`. New versions are published on their own, at most once a day: the release autopilot computes major, minor or patch from the merged pull requests, writes the version's documentation and merges `develop` into `main` ([release process](docs/RELEASE.md#automatic-releases-release-autopilot)).

- **Issues**: [report a bug or request a feature](https://github.com/krovomi/WorkPilot-AI/issues)
- **Discussions**: [ask a question](https://github.com/krovomi/WorkPilot-AI/discussions)

---

## License

**AGPL-3.0**, GNU Affero General Public License v3.0. WorkPilot AI is free to use. If you modify and distribute it, or run it as a service, your code must also be open source under AGPL-3.0. Commercial licensing is available for closed-source use cases.

[![GitHub Repo stars](https://img.shields.io/github/stars/krovomi/WorkPilot-AI?style=social)](https://github.com/krovomi/WorkPilot-AI/stargazers)

[![Star History Chart](https://api.star-history.com/svg?repos=krovomi/WorkPilot-AI&type=Date)](https://star-history.com/#krovomi/WorkPilot-AI&Date)
