# Changelog

All notable changes to WorkPilot AI are documented here. The full historical
detail (including the complete 1.0.0 notes) lives in
[docs/CHANGELOG.md](docs/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

---

## 1.2.0 - Declarative Workflows, Skills Registry & hermes-agent

The pipeline stops being hard-coded. A build is now described by
`workflows/<name>/workflow.yaml`, resolved against the effort level you picked,
your provider's real capabilities and the files the task touched — and the
resolved plan is shown to you before anything runs.

Underneath, four disconnected skill systems become one registry with a single
source and generated per-harness outputs.

### ✨ Declarative Agentic Workflows

- **A build is data.** `workflow.yaml` declares eleven phases — brainstorm,
  spec, planning, coding, design-check, review, qa, adversarial-review,
  spec-conformance, verify, observe — instead of a Python sequence nothing
  could be inserted into.
- **Your effort level now changes what runs.** `low` buys a single pass through
  the gates that cannot be skipped; `ultrathink` buys a second reading whose
  job is to disagree with the first. Before, a typo fix and an architectural
  change ran the same number of passes.
- **The resolved profile is shown before the build starts**, in the Kanban task
  panel and in the CLI — including the phases your level dropped, why, and what
  the level above would add.
- **On by default.** `WORKPILOT_WORKFLOW_ENGINE=0` runs the previous pipeline.
- **Methodologies are interchangeable.** The coding phase names its methodology
  (`superpowers/test-driven-development` by default); changing that line
  changes how coding is done.

### ✨ Skills Registry

- **One source, N outputs.** `skills/` is authored; `.agents/skills/`,
  `.claude/skills/`, `.github/skills/`, `.cursor/skills/` and
  `.gemini/commands/` are generated and verified in CI.
- **Versioned packs with two-axis resolution** — a project on .NET 8 and one on
  .NET 10 get different variants of the same pack, and a breaking upstream
  release forks a variant instead of overwriting the pinned one.
- **76 dead commands removed from the command palette.** Every BMAD skill
  pointed at a runtime that is gitignored and absent from a fresh clone: they
  were listed, and every one failed on invocation. A skill whose runtime is
  missing is no longer emitted.
- **Upstream packs tracked and vendored on demand** — superpowers, mattpocock,
  impeccable, task-observer and hermes-agent — with a weekly sync that opens a
  pull request and never merges one.
- **One frontmatter parser** instead of four with divergent semantics.

### ✨ hermes-agent

- Supported as a harness with **no extra output**: it already reads
  `.agents/skills/` and `AGENTS.md`. One `hermes skills trust` in the checkout
  is all it needs.
- Available as an **optional, scoped pack** — systematic-debugging, spike, the
  runtime debuggers, merge-reconciler, and procedures for driving other coding
  agents.
- Its learning loop feeds ours: skills hermes authored from its own experience
  arrive as **candidates for review**, never as promotions.

### ✨ Language-Aware Subagents

- The roster is composed from phase defaults, a language overlay and the
  caller's own agents. A Rust card and a .NET card no longer receive the same
  generic `test-runner` prompt.
- Emitted per harness from one registry, with tool names translated where the
  mapping is verified and passed through — visibly — where it is not.

### ✨ Learning Loop: Procedural Memory

- What a build learns can finally reach skill and subagent definitions, under
  four cumulative gates: seen N times, corroborated by an **external** signal,
  no regression on replayed golden episodes, and merged by a human.
- Per-agent experience ledgers keyed by `(agent, language, workflow)`, so
  `test-runner` on Rust learns from `test-runner` on Rust.
- `mem-search` — three-layer progressive retrieval over the memories that
  already exist, without adding a fourth store.

### 🛠️ Improvements

- **Honest multi-provider.** Selecting Mistral, DeepSeek, Grok or Meta used to
  run the task on Claude behind a warning nobody reads. Provider capabilities
  are declared, and a degradation is recorded and surfaced rather than
  pretended.
- A phase asking for subagents on a provider that has none degrades to
  sequential execution with a context reset — and that degradation is now
  applied at execution, not merely computed.
- Deterministic gates (impeccable's 59 local rules) run at every effort level:
  they cost no tokens, so there is no level at which skipping them saves
  anything.
- `AGENTS.md` at the repository root, read by Copilot, Codex, Cursor, Amp and
  OpenCode; `CLAUDE.md` imports it.
- Faster git hooks: pre-commit limited to staged files, pre-push quick by
  default (`PRE_PUSH_FULL=1` for the full suite).
- Detailed Windows/macOS/Linux installation guide.
- ~10 000 lines of dead code removed, along with an installer that overwrote
  the user's global Claude configuration.

### 🐛 Bug Fixes

- **"Resume with X" no longer loses your choice.** The provider marker is
  single-shot, and the workflow resolution consumed it before the session that
  was meant to honour it started.
- **Sidebar labels** carried emoji that rendered as empty boxes in French, and
  the leftover separating space in English.
- **The `tests-pass` hard gate is actually evaluated.** It was declared "never
  skipped" while nothing checked whether the tests passed, so a build could
  conclude green with a red suite. A gate with no evidence reports *unknown*,
  never *clean*.
- QA pruned by effort is no longer indistinguishable from QA passed — a skipped
  phase can no longer manufacture corroboration for the learning loop.
- Two packs providing the same skill name is reported as a collision instead of
  being resolved by alphabetical luck.
- A version bump no longer rewrites both manifests end to end.
- The workflow profile panel answers for **your** project again: a path-injection
  autofix had confined it to WorkPilot's own checkout, so it returned nothing
  for anyone building anything else.
- Security: closed a run-cancel IDOR, session-revocation and process-kill bugs;
  fail closed on server mode; locked down credential endpoints; removed shell
  interpolation; patched Electron; cleared every critical, high and moderate
  npm advisory; pinned third-party actions to commit SHAs.
- Backend port sync no longer depends on a Python script called from Node.
- Setup wizard: project-not-found and auto-advance fixed.
- UTF-8 BOMs removed and a UTF-16 data file converted.

---

## 1.1.0 - Multi-Provider, Formula Lab & Autonomous Agents

A large feature release: WorkPilot AI is now fully provider-agnostic, gains
mid-task execution control, a cost/success estimation lab, and a wave of new
autonomous agents and integrations. 150+ features and 150+ fixes since 1.0.0.

### ✨ Multi-Provider & Model Support

- **Provider-agnostic pipeline** — drive every phase with Claude, OpenAI, Gemini, Grok, GitHub Copilot, Azure OpenAI, a local Ollama model, or any OpenAI-compatible endpoint.
- **Provider-neutral one-shot core** so title/terminal-name/spec-interview/visual-proof no longer assume Claude.
- **Provider-neutral conversation log** (JSONL) that is replayed into the next provider on resume.
- **Live + static model catalogs** unioned per provider, with provider-aware model selection.
- New models across catalogs: **Claude Opus 4.8**, Opus 4.7, **Fable 5**, plus Anthropic versioned models.
- **Centralized model registry** shared across backend modules.

### ✨ Execution Control

- **Hot-Swap LLM** — change provider, model, or reasoning effort mid-task; context is replayed onto the new engine on the next turn.
- **Pause & Resume** across all task statuses and Kanban cards, with provider switch on resume ("Reprendre avec…").
- **Per-phase re-run** — redo planning, coding, or validation on demand.
- **Execution formula gate** before starting a task.

### ✨ Kanban & Task Workflow

- **Formula Lab** — pre-flight cost/success estimation per Provider × Model × Effort, calibrated on real usage history, with EUR pricing, sortable comparison table, and a hybrid "Refine with AI" pass.
- **PR-first guided human review**, plus "approve & close" and reversible task abandon.
- Chip-based filter panel, task duplication, Quick Command Bar, previous/next task navigation, per-task phase indicator, and Kanban column selection from the task pop-in.
- Acceptance criteria imported from Azure/Jira and grouped by scenario.

### ✨ New Agents & Intelligence

- **Consensus Arbiter** — reconciles conflicting security/QA opinions into one verdict.
- **Agent Coach** — cost/model coaching from real usage.
- **Carbon Profiler** — energy (kWh) and carbon footprint of agent runs.
- **Release Coordinator** and a **Technical Debt** dashboard.
- **Flaky Test Detective**, **Virtual Reviewer**, **Blast Radius**, **Bounty Board**, loop detection, and self-review modules.
- **Agent Debugger** with persistent state and breakpoints, plus Agent Replay.

### ✨ Testing

- **Live / streaming test generation** surface.
- **.NET test automation**, target-test generation, strict/per-task **TDD mode**, and in-UI plan editing.

### ✨ Visual & Design

- **Design-to-Code** service and a **visual programming canvas** (architecture drawing → scaffold).
- **Visual proof** with automated screenshot capture, feature navigation, window-only capture, and PR-comment integration.
- **App Emulator** embedded in the task modal.

### ✨ Onboarding

- **Setup Hub** post-install checklist and a step-by-step **guided tour** (coachmarks), plus guardrails.

### ✨ Integrations & Collaboration

- **Multi-user server mode** — central deployment with JWT / Microsoft Entra auth, per-user claims, run manager, and invitation-only signup.
- **Azure DevOps authentication** for worktree operations; inline Azure/Jira images and richer work-item retrieval.
- **Slack / Teams bots**, real Self-Healing alert channels (Slack / email / GitHub), and Windsurf integration improvements.

### ✨ Memory, Analytics & Optimization

- **Graphiti memory integration** and a continuous **learning loop**.
- **Usage-tracking dashboard**, cost predictor, and cost estimator.
- **LLM token optimization** (system prompt, effort mapping, prompt caching, context compaction).
- **Smart-merge / rebase protection** for `.workpilot` preservation.

### 🔐 Security

- Audit-trail encryption, hardened security validation and sandbox approval, injection guard, license governance, and SSRF hardening on outbound webhooks.

### 🐛 Bug Fixes & Stability

- 150+ fixes, including Windows startup-freeze fixes (synchronous Credential Manager and subprocess spawns moved off the main thread), credential utilities, browser mock, streaming/WebSocket reconnection, worktree data-loss protection, and numerous i18n and UI corrections.

### 📚 Documentation

- Refreshed root, backend, and frontend READMEs with the latest features; corrected stale module paths; and updated the public wiki.

---

## 1.0.0 - Initial WorkPilot AI Release

Initial public release. See [docs/CHANGELOG.md](docs/CHANGELOG.md) for the
complete 1.0.0 feature list.
