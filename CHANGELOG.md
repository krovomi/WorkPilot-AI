# Changelog

All notable changes to WorkPilot AI are documented here. The full historical
detail (including the complete 1.0.0 notes) lives in
[docs/CHANGELOG.md](docs/CHANGELOG.md).

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
