# WorkPilot AI

**Autonomous multi-agent coding framework that plans, builds, and validates software for you.**

![WorkPilot AI Kanban Board](.github/assets/WorkPilot-AI-Kanban.png)

[![License](https://img.shields.io/badge/license-AGPL--3.0-green?style=flat-square)](./LICENSE)
[![Discord](https://img.shields.io/badge/Discord-Join%20Community-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/KCXaPBr4Dj)
[![YouTube](https://img.shields.io/badge/YouTube-Subscribe-FF0000?style=flat-square&logo=youtube&logoColor=white)](https://www.youtube.com/@AndreMikalsen)
[![CI](https://img.shields.io/github/actions/workflow/status/krovomi/WorkPilot-AI/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/krovomi/WorkPilot-AI/actions)

---

## Download

### Stable Release

<!-- STABLE_VERSION_BADGE -->
[![Stable](https://img.shields.io/badge/stable-1.2.1-blue?style=flat-square)](https://github.com/krovomi/WorkPilot-AI/releases/tag/v1.2.1)
<!-- STABLE_VERSION_BADGE_END -->

<!-- STABLE_DOWNLOADS -->
| Platform | Download |
|----------|----------|
| **Windows** | [WorkPilot-AI-1.2.1-win32-x64.exe](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.2.1/WorkPilot-AI-1.2.1-win32-x64.exe) |
| **macOS (Apple Silicon)** | [WorkPilot-AI-1.2.1-darwin-arm64.dmg](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.2.1/WorkPilot-AI-1.2.1-darwin-arm64.dmg) |
| **macOS (Intel)** | [WorkPilot-AI-1.2.1-darwin-x64.dmg](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.2.1/WorkPilot-AI-1.2.1-darwin-x64.dmg) |
| **Linux** | [WorkPilot-AI-1.2.1-linux-x86_64.AppImage](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.2.1/WorkPilot-AI-1.2.1-linux-x86_64.AppImage) |
| **Linux (Debian)** | [WorkPilot-AI-1.2.1-linux-amd64.deb](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.2.1/WorkPilot-AI-1.2.1-linux-amd64.deb) |
| **Linux (Flatpak)** | [WorkPilot-AI-1.2.1-linux-x86_64.flatpak](https://github.com/krovomi/WorkPilot-AI/releases/download/v1.2.1/WorkPilot-AI-1.2.1-linux-x86_64.flatpak) |
<!-- STABLE_DOWNLOADS_END -->

### Beta Release

> Beta releases may contain bugs and breaking changes. [View all releases](https://github.com/krovomi/WorkPilot-AI/releases)

<!-- BETA_VERSION_BADGE -->
[![Beta](https://img.shields.io/badge/beta-none%20published-lightgrey?style=flat-square)](https://github.com/krovomi/WorkPilot-AI/releases)
<!-- BETA_VERSION_BADGE_END -->

<!-- BETA_DOWNLOADS -->
_No beta build is currently published. The table above is the latest stable release._
<!-- BETA_DOWNLOADS_END -->

> All releases include SHA256 checksums and VirusTotal scan results for security verification.

---

## Quick Start

1. **Download and install** the app for your platform
2. **Open your project** — select a git repository folder
3. **Connect your AI provider** — Claude (OAuth), API key, or any OpenAI-compatible endpoint
4. **Create a task** — describe what you want to build
5. **Watch it work** — agents plan, code, and validate autonomously

Or from source:

```sh
pnpm install
pnpm run dev
```

See [Installation et Configuration](#installation-et-configuration) below for detailed instructions.

---

## Features

### Autonomous Development Pipeline

| Feature | Description |
|---------|-------------|
| **Kanban Board** | Visual task management from planning through completion with real-time agent progress |
| **Multi-Agent Pipeline** | Planner → Coder → QA Reviewer → QA Fixer pipeline runs autonomously end-to-end |
| **Parallel Execution** | Up to 12 simultaneous agent terminals for parallel builds |
| **Isolated Workspaces** | Every task runs in a dedicated git worktree — your main branch stays safe |
| **AI-Powered Merge** | Semantic conflict resolution when integrating worktrees back to main |
| **QA Auto-Fix Loop** | Agents automatically detect, fix, and revalidate failing acceptance criteria |
| **Spec Approval Workflow** | Review and approve AI-generated specifications before implementation begins |
| **Hot-Swap LLM** | Change provider, model, or reasoning effort mid-task — the next turn resumes on the new engine with context replayed |
| **Pause & Resume** | Suspend a running task and resume later with full context preserved, optionally on a different provider |
| **Per-Phase Re-run** | Redo any phase (planning, coding, validation) on demand without restarting the whole task |
| **PR-First Review Flow** | Guided human-review with a DoD checklist, "approve & close", and reversible task abandon |
| **Declarative Workflows** | A build is described as phases in `workflows/<name>/workflow.yaml`; the engine resolves them against your effort level, the provider's capabilities, and the files the task touches. On by default |
| **Resolved Profile Preview** | See which phases your effort setting bought — and what the next level up would add — in the task detail modal, *before* the build starts |

### Multi-Agent Orchestration

| Feature | Description |
|---------|-------------|
| **Mission Control** | NASA-style dashboard for orchestrating multiple agents simultaneously — live status, token consumption, file changes, and per-agent reasoning |
| **Agent Replay & Debug** | Step-by-step replay of any agent session with timeline navigation, file diffs, breakpoints, and token heatmaps |
| **Decision Logger** | Real-time visualization of agent decision trees and trade-off rationale |
| **Consensus Arbiter** | Reconciles conflicting opinions from security scans and QA reviewers into a single verdict |
| **Agent Coach** | Analyzes real usage to suggest cheaper models, better effort levels, and prompt tweaks per agent |
| **Pair Programming** | Interactive real-time AI coding partner with live suggestions and conversation-driven development |
| **Learning Mode** | Educational mode with step-by-step explanations of agent decisions |

### Specialized Agents

| Agent | Role |
|-------|------|
| **Planner** | Complexity assessment, phased subtask breakdown, dependency analysis |
| **Coder** | Context-aware implementation with parallel subagent spawning |
| **QA Reviewer / Fixer** | Acceptance criteria validation and automated issue resolution |
| **Test Generator** | Unit and integration test generation with live streaming of the code as it is written |
| **Flaky Test Detective** | Parses test reports (JUnit XML, .NET TRX, …) to surface intermittently failing tests |
| **Refactorer** | Safe code refactoring with pattern detection and API migration |
| **Documenter** | README, API docs, and architecture documentation generation |
| **Migration Agent** | Framework and library migration with breaking change detection |
| **Release Coordinator** | Orchestrates release readiness, changelog, and version bumps |
| **Memory Manager** | Graphiti-based knowledge graph management across sessions |

### Integrations

| Platform | Capabilities |
|----------|-------------|
| **GitHub** | Import issues, AI investigation, PR review, batch review wizard, auto-PR creation |
| **GitLab** | Issues and merge request management with AI severity categorization |
| **Azure DevOps** | Work item import, PR review, batch operations — _experimental: backend still returns mock data for several endpoints, see [shared_docs/CONFIGURATION.md](shared_docs/CONFIGURATION.md)_ |
| **Linear** | Bulk issue import with team/project filtering |
| **Jira** | Issue management integration |
| **MCP Marketplace** | Browse, install, and configure Model Context Protocol servers |
| **Custom MCPs** | Define and host custom MCP servers with local authentication |
| **Windsurf** | Windsurf IDE integration via Connect protocol |

### AI Providers & Authentication

| Provider | Auth Method |
|----------|-------------|
| **Anthropic Claude** | OAuth (subscription) or API key |
| **OpenAI** | OAuth (subscription) or API key |
| **Google Gemini** | API key |
| **Grok / xAI** | API key |
| **Ollama** | Local endpoint |
| **Azure OpenAI** | API key + endpoint |
| **GitHub Copilot** | OAuth (subscription) or API key |
| **Custom endpoints** | Any OpenAI-compatible API (e.g. z.ai for GLM models) |

**Multi-account switching** — Register multiple profiles per provider. WorkPilot AI automatically switches to an available account when one hits a rate limit.

### Code Intelligence

| Feature | Description |
|---------|-------------|
| **Insights** | AI chat interface for exploring and understanding your codebase with semantic search |
| **Ideation** | Discovers performance bottlenecks, security vulnerabilities, code quality issues, and UI/UX improvements |
| **Architecture Visualizer** | Dependency graphs, module hierarchy, and component relationship diagrams |
| **Performance Profiler** | AI-powered bottleneck identification with optimization suggestions |
| **Dependency Sentinel** | Monitors security vulnerabilities, version conflicts, and outdated dependencies |
| **Self-Healing Codebase** | Automatically generates fixes when CI tests fail; integrates with Sentry, Datadog, PagerDuty for production incidents |
| **Technical Debt Tracker** | Continuously scores code health, tracks and ages debt items, and proposes auto-fixes with PRs |
| **Risk Classifier** | Scores code changes by risk level with impact assessment |

### Developer Productivity

| Feature | Description |
|---------|-------------|
| **Guided Onboarding** | Setup Hub checklist plus a step-by-step coachmark tour to configure providers and integrations |
| **Roadmap** | AI-assisted feature planning with prioritization and phased rollout |
| **Changelog** | Auto-generates release notes from completed tasks |
| **Natural Language Git** | AI-generated semantic commit messages from diffs |
| **Auto-Refactoring** | Pattern-based and architectural code transformations |
| **Code Migration** | Large-scale codebase migrations across frameworks and libraries |
| **Design to Code** | Converts UI mockups and screenshots to React/HTML |
| **Pipeline Generator** | Generates GitHub Actions, GitLab CI, and Azure Pipelines configurations |
| **Browser Agent** | Autonomous browser interaction for E2E test generation and visual regression |
| **Arena Mode** | Side-by-side comparison of different AI models on the same task |
| **Voice Control** | Hands-free task and terminal control via speech-to-text |
| **Multi-Repo Orchestration** | Coordinate changes across multiple repositories simultaneously |
| **Code Playground** | Sandbox environment for testing code snippets in isolation |
| **Prompt Optimizer** | Analyzes and rewrites prompts for better AI output |

### Memory & Context

| Feature | Description |
|---------|-------------|
| **Memory System (Graphiti)** | Graph-based semantic memory — agents retain insights across sessions |
| **Skills System** | Provider-agnostic [Agent Skills](https://agentskills.io) packs under `.agents/skills/`, served to the Kanban command bar and mirrored per harness (Claude Code, Copilot, Codex, Cursor, Gemini) |
| **Memory Search** | Three-layer progressive retrieval over past builds — an index costs ~100 tokens, timelines and full records are fetched only on demand |
| **hermes-agent** | [hermes-agent](https://github.com/NousResearch/hermes-agent) skills are read from the same `.agents/skills/`; skills it authors arrive as *candidates* for review, never auto-adopted |
| **Context Management** | Intelligent context building with file relevance ranking and dependency graph analysis |
| **Session History** | Browse and replay past agent sessions with full statistics |

### Analytics & Monitoring

| Feature | Description |
|---------|-------------|
| **Analytics Dashboard** | Token consumption, cost tracking, success rates, and execution time metrics — live SQLite-backed API; falls back to an explicit 503 when the analytics DB is unavailable |
| **Formula Lab** | Pre-flight cost/success estimation per Provider × Model × Effort, calibrated on your real usage history |
| **Cost Estimator** | Per-task cost calculation with provider comparison and budget alerts |
| **Carbon Profiler** | Estimates the energy (kWh) and carbon footprint of your agent runs |
| **Rate Limit Monitor** | Real-time usage tracking with proactive warnings and auto-switching triggers |
| **Workflow Logger** | Structured execution logs with trace IDs for all agents, skills, and hooks |
| **Learning Loop** | Extracts patterns from completed builds and A/B-replays promoted changes, so a suggestion is backed by an observed run rather than a guess |

### Customization

| Feature | Description |
|---------|-------------|
| **7 Color Themes** | Default, Dusk, Lime, Ocean, Retro, Neo, Forest — each with light and dark variants |
| **Custom Theme Editor** | Color picker with live preview, export, and import |
| **Bilingual UI** | Full French and English interface |
| **Command Palette** | Keyboard-driven access to all features with fuzzy search |
| **Plugin Marketplace** | Browse and install community plugins |

### Deployment & Team

| Feature | Description |
|---------|-------------|
| **Multi-User Server Mode** | Central deployment with JWT / Microsoft Entra auth, per-user claims, and a shared run manager |
| **Invitation-Only Signup** | Self-service registration gated by admin invitations, with SMTP delivery and rate limiting |
| **Notifications** | Multi-channel "PR ready" alerts (Slack, email, webhook) with SSRF hardening |

---

## Interface

### Kanban Board
Visual task management from planning through completion. Create tasks and monitor agent progress in real-time.

### Agent Terminals
AI-powered terminals with one-click task context injection. Spawn multiple agents for parallel work.

![Agent Terminals](.github/assets/WorkPilot-AI-Agents-terminals.png)

### Mission Control
NASA-style multi-agent orchestration hub with per-agent monitoring, model assignment, and live decision visualization.

### Roadmap
AI-assisted feature planning with competitor analysis and audience targeting.

![Roadmap](.github/assets/WorkPilot-AI-roadmap.png)

### Additional Views
- **Insights** — AI chat for codebase exploration and semantic search
- **Ideation** — Discover improvements, vulnerabilities, and performance issues
- **Changelog** — Generate release notes from completed tasks
- **Architecture Visualizer** — Interactive dependency and module graphs
- **Agent Replay** — Step-by-step session replay with breakpoints and diffs
- **Analytics** — Usage, cost, and performance dashboards

---

## Architecture Détaillée

### Vue d'Ensemble

WorkPilot AI est une application de bureau autonome basée sur une architecture multi-agents qui orchestre le cycle de vie complet du développement logiciel. Le système combine un backend Python puissant avec une interface utilisateur Electron moderne pour offrir une expérience de développement transparente.

### Architecture Multi-Agents

#### Pipeline Autonome de Développement
1. **Agent Planner** - Analyse la complexité et décompose les tâches en sous-tâches
2. **Agent Coder** - Implémente les fonctionnalités avec des sous-agents parallèles
3. **Agent QA Reviewer** - Valide les implémentations selon les critères d'acceptation
4. **Agent QA Fixer** - Résout automatiquement les problèmes identifiés

#### Agents Spécialisés
- **Test Generator** - Génération de tests unitaires et d'intégration
- **Refactorer** - Refactoring sécurisé du code avec détection de patterns
- **Documenter** - Génération automatique de documentation
- **Migration Agent** - Migration de frameworks et bibliothèques
- **Memory Manager** - Gestion de la base de connaissances Graphiti

### Architecture Technique

#### Backend Python (`apps/backend/`)
```
apps/backend/
├── core/                # Client, authentification, worktree, plateforme
│   ├── client.py        # Client Claude Agent SDK
│   ├── auth.py          # Gestion multi-profils OAuth
│   ├── worktree.py      # Isolation des espaces de travail Git
│   └── platform.py      # Abstraction cross-plateforme
├── agents/              # Logique d'exécution des agents
│   ├── planner.py       # Agent de planification
│   ├── coder.py         # Agent de développement
│   └── session.py       # Gestion des sessions
├── qa/                  # Pipeline de validation QA
│   ├── reviewer.py      # Validation des critères
│   ├── fixer.py         # Résolution automatique
│   └── loop.py          # Boucle de validation
├── runners/             # Points d'entrée (spec_runner, github, azure_devops)
├── spec/                # Création et gestion des specs
├── skills/              # Système de compétences AI optimisé
├── cli/                 # Interface ligne de commande
├── context/             # Construction du contexte des tâches
├── services/            # Services d'intégration externes
├── integrations/        # Connecteurs (GitHub, GitLab, etc.)
├── project/             # Analyse et détection de projets
├── merge/               # Système de fusion sémantique
├── self_healing/        # Surveillance de santé + auto-réparation
├── tech_debt/           # Suivi et résolution de la dette technique
├── consensus_arbiter/   # Arbitrage des avis d'agents (sécurité/QA)
├── agent_coach/         # Conseils coût/modèle basés sur l'usage réel
├── carbon_profiler/     # Empreinte énergie/carbone des exécutions
├── release_coordinator/ # Préparation des releases
├── flaky_test_detective/# Détection des tests instables
├── streaming/           # Diffusion temps réel des sessions d'agents
├── server/              # Mode serveur multi-utilisateurs (auth, claims)
└── prompts/             # Prompts des agents (60+ agents spécialisés)
```

> Le backend s'est étoffé en **90+ modules spécialisés** (accessibilité, dérive d'architecture, gouvernance de licences, orchestration multi-repo, etc.). Voir [apps/backend/README.md](apps/backend/README.md) et la [table des modules du wiki](https://github.com/krovomi/WorkPilot-AI/wiki) pour l'inventaire complet auto-généré.

#### Frontend Electron (`apps/frontend/`)
```
apps/frontend/src/
├── main/                # Processus principal Electron
│   ├── agent/           # Gestion des files d'attente
│   ├── claude-profile/  # Gestion multi-profils
│   ├── terminal/        # Daemon PTY et cycle de vie
│   ├── platform/        # Abstraction cross-plateforme
│   ├── ipc-handlers/    # 100+ modules de gestion IPC
│   ├── services/        # Récupération de session SDK, credentials
│   └── utils/           # Chemins, isolation git, nettoyage worktree
├── preload/             # Pont contextIsolation (API exposée au renderer)
├── renderer/            # Interface React
│   ├── components/      # Kanban, terminaux, settings, task detail…
│   ├── stores/          # État Zustand par domaine
│   ├── contexts/        # Providers React (thème, i18n)
│   ├── hooks/           # Hooks au niveau application
│   ├── lib/             # Utilitaires de présentation
│   └── locales/         # Traductions FR / EN
└── shared/              # Partagé main/renderer
    ├── types/           # Définitions TypeScript
    ├── constants/       # Constantes application
    ├── i18n/            # Configuration i18n
    └── utils/           # Utilitaires partagés
```

### Flux de Données et État

#### Flux d'Exécution des Agents
1. **Création de Tâche** → Utilisateur crée une tâche dans l'UI/CLI
2. **Génération de Spec** → L'AI analyse la complexité et crée une spécification
3. **Phase de Planification** → Le Planner décompose en sous-tâches
4. **Implémentation** → Le Coder exécute avec des sous-agents parallèles
5. **Validation QA** → Le Reviewer valide l'implémentation
6. **Résolution des Problèmes** → Le Fixer résout les problèmes identifiés
7. **Phase de Fusion** → Fusion sémantique vers la branche principale

#### Gestion d'État
- **État Projet** → [`main/project-store.ts`](apps/frontend/src/main/project-store.ts)
- **État Tâche/Spec** → [`renderer/stores/task-store.ts`](apps/frontend/src/renderer/stores/task-store.ts)
- **État Terminal** → [`renderer/stores/terminal-store.ts`](apps/frontend/src/renderer/stores/terminal-store.ts)
- **État Agent** → [`main/agent/agent-state.ts`](apps/frontend/src/main/agent/agent-state.ts)
- **État Paramètres** → [`renderer/stores/settings-store.ts`](apps/frontend/src/renderer/stores/settings-store.ts)

### Sécurité et Isolation

#### Modèle de Sécurité à 3 Couches
1. **Sandbox OS** → Commandes Bash exécutées en isolation
2. **Restrictions Filesystem** → Opérations limitées au répertoire projet
3. **Allowlist Dynamique** → Commandes approuvées selon la stack détectée

#### Gestion des Credentials
- **Système de Profils Claude** → Gestion OAuth multi-comptes
- **Stockage Secure** → Keychain OS / Credential Manager
- **Rotation Automatique** → Cycle de vie des tokens OAuth
- **Validation Input** → Chemins et commandes sanitizées

### Performance et Scalabilité

#### Modèle de Concurrence
- **Parallélisme d'Agents** → Jusqu'à 12 terminaux AI parallèles
- **Opérations Async** → I/O non-bloquant partout
- **Pooling de Ressources** → Connexions et sessions réutilisées
- **Load Balancing** → Switching automatique multi-comptes

#### Optimisations
- **Optimisation Tokens** → Compression et cache du contexte
- **Gestion Mémoire** → Cleanup agressif et checkpoints
- **Optimisation Réseau** → Pooling de connexions et retries
- **Performance UI** → Virtual scrolling et lazy loading

---

## Installation et Configuration

### Prérequis Système

#### Configuration Matérielle Minimale
- **OS** : Windows 10+, macOS 10.15+, Ubuntu 20.04+
- **RAM** : 8GB minimum (16GB recommandé)
- **Stockage** : 2GB d'espace libre
- **Réseau** : Connexion internet stable

#### Dépendances Logicielles
- **Node.js ≥ 20** (la CI construit sur Node 22)
- **pnpm ≥ 8** (le dépôt est épinglé sur pnpm 10 via `packageManager`)
- **Python 3.12+** (Pour le backend)
- **Git** (Dépôt initialisé obligatoire)
- **Claude Code CLI** : `pnpm add -g @anthropic-ai/claude-code`

### Méthodes d'Installation

#### Option 1 : Application Bureau (Recommandé)

1. **Téléchargement**
   - Visitez [GitHub Releases](https://github.com/krovomi/WorkPilot-AI/releases)
   - Téléchargez la version stable pour votre plateforme

2. **Installation**
   - **Windows** : Exécutez `WorkPilot-AI-1.0.0-win32-x64.exe`
   - **macOS** : Ouvrez `WorkPilot-AI-1.0.0-darwin-arm64.dmg`
   - **Linux** : Lancez `WorkPilot-AI-1.0.0-linux-x86_64.AppImage`

3. **Premier Lancement**
   - Lancez l'application
   - Suivez l'assistant de configuration
   - Connectez votre provider AI

#### Option 2 : Développement depuis Source

1. **Clonage du Dépôt**
   ```bash
   git clone https://github.com/krovomi/WorkPilot-AI.git
   cd WorkPilot-AI
   ```

2. **Installation Automatique**
   ```bash
   pnpm install
   pnpm run dev
   ```
   *Crée automatiquement l'environnement virtuel Python et installe toutes les dépendances*

3. **Lancement Manuel — Guide Pas à Pas par OS**

   Si l'installation automatique échoue (dépendances Python manquantes, environnement corrompu, etc.), suivez ces étapes détaillées.

   **Prérequis communs**
   - Node.js ≥ 20 et pnpm ≥ 8 disponibles dans le PATH
   - Python 3.12+ installé depuis [python.org](https://www.python.org/downloads/) — sur Windows, évitez le Python du Microsoft Store, il cause fréquemment des soucis de PATH et de permissions
   - Git installé

   **Windows (PowerShell)**
   ```powershell
   cd WorkPilot-AI

   # Backend : créer et activer l'environnement virtuel
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt

   # Le backend a un SECOND venv indépendant sous apps/backend — voir
   # "Notes Spécifiques Windows" ci-dessous, il a besoin du même traitement pywin32
   cd apps\backend
   python -m venv .venv
   .venv\Scripts\python.exe -m pip install -r requirements.txt
   cd ..\..

   # Frontend
   cd apps\frontend
   pnpm install
   cd ..\..

   pnpm run dev
   ```
   > ⚠️ Sur Windows, plusieurs pièges classiques attendent ici (pywin32 sur les DEUX venvs, élévation UAC, Smart App Control qui bloque les binaires natifs npm). Lisez **[Notes Spécifiques Windows](#notes-spécifiques-windows)** juste après cette section avant de lancer `pnpm run dev` pour la première fois — ça évite la majorité des galères de premier lancement.

   **macOS / Linux (bash/zsh)**
   ```bash
   cd WorkPilot-AI

   # Backend : créer et activer l'environnement virtuel
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt

   # Frontend
   cd apps/frontend
   pnpm install
   cd ../..

   pnpm run dev
   ```

4. **Vérifier que le backend répond**
   ```bash
   curl http://127.0.0.1:9000
   ```

### Notes Spécifiques Windows

Le setup Windows a davantage de pièges que macOS/Linux, tous rencontrés et résolus en conditions réelles. Parcourez cette liste **avant** votre premier `pnpm run dev` si vous êtes sur Windows.

#### 1. `pywin32` doit être installé sur **DEUX** environnements virtuels distincts

Le projet a deux venvs Python indépendants : celui à la **racine** du dépôt (`.venv`, utilisé par le serveur FastAPI principal) et celui sous **`apps/backend/.venv`** (utilisé par les commandes CLI/QA internes lancées par Electron). `pip install -r requirements.txt` n'installe pas automatiquement l'un depuis l'autre — répétez l'installation dans les deux :

```powershell
# Venv racine
.\.venv\Scripts\python.exe -m pip install --upgrade "pywin32>=312"
.\.venv\Scripts\python.exe .\.venv\Scripts\pywin32_postinstall.py -install
.\.venv\Scripts\python.exe -c "import pywintypes; print('OK')"

# Venv du backend
cd apps\backend
.venv\Scripts\python.exe -m pip install --upgrade "pywin32>=312"
.venv\Scripts\python.exe .venv\Scripts\pywin32_postinstall.py -install
.venv\Scripts\python.exe -c "import pywintypes; print('OK')"
cd ..\..
```

Les deux dernières commandes doivent chacune afficher `OK`. Si `import pywintypes` échoue encore après le postinstall (les DLL sont copiées mais le module reste introuvable — signe que le fichier `.pth` de pywin32 n'a pas été traité par l'interpréteur), n'insistez pas à patcher symptôme par symptôme : **supprimez et recréez ce venv à neuf**, c'est ce qui résout le problème de façon fiable :

```powershell
Remove-Item -Recurse -Force .venv
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pip install --upgrade "pywin32>=312"
.venv\Scripts\python.exe .venv\Scripts\pywin32_postinstall.py -install
.venv\Scripts\python.exe -c "import pywintypes; print('OK')"
```

Si le problème persiste même après une recréation complète du venv, c'est le signe d'une installation Python **de base** corrompue (pas seulement le venv) — voir **Dépannage Courant → Problèmes Python / venv**.

#### 2. `pnpm run dev` ouvre une seconde console élevée (UAC)

C'est voulu : voir `apps/frontend/scripts/dev-elevated.cjs`. WorkPilot AI relance tout le stack Electron en administrateur sur Windows, nécessaire pour une fonctionnalité de capture visuelle admin-only. Si vous n'avez pas besoin de cette fonctionnalité — ou si cette console élevée échoue à écrire `apps/frontend/.env-files/.env` (`PermissionError`) — désactivez l'élévation :

```powershell
$env:WORKPILOT_NO_ELEVATE = "1"
pnpm run dev
```

Si vous avez déjà lancé l'app une fois **avec** élévation avant de désactiver, le fichier `apps/frontend/.env-files/.env` peut rester marqué par le process administrateur qui l'a créé (visible via `Get-Acl` : propriétaire `BUILTIN\Administrateurs`) et bloquer toute écriture ultérieure par un process non-admin, même avec des permissions NTFS qui semblent correctes. Supprimez-le pour qu'il soit régénéré proprement :

```powershell
Remove-Item "apps\frontend\.env-files\.env" -Force
```

#### 3. Smart App Control / Application Control bloque les binaires natifs npm

Si `pnpm run dev` plante sur `electron-vite dev` avec une erreur du type `Error: An Application Control policy has blocked this file` (souvent sur un fichier `.node` dans `node_modules`, par exemple un binding natif de `rolldown` ou un autre paquet compilé), c'est **Smart App Control** (Windows 11) ou une politique **WDAC** qui bloque le chargement d'un binaire natif fraîchement installé et non reconnu.

Vérifiez l'état :
```powershell
Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy" -Name "VerifiedAndReputablePolicyState" -ErrorAction SilentlyContinue
```
`1` = activé (bloque). Sur un **PC personnel**, désactivez-le via *Sécurité Windows → Contrôle des applications et du navigateur → Paramètres du Contrôle des applications intelligent → Désactivé*, puis **redémarrez** (le changement n'est pas pris en compte à chaud).

> ⚠️ Cette désactivation est définitive sans réinstallation complète de Windows — c'est une limitation volontaire de Microsoft.

Sur un **PC d'entreprise** (politique WDAC imposée), il faudra faire autoriser les binaires natifs Node par votre IT plutôt que de désactiver quoi que ce soit vous-même.

#### 4. PowerShell ≠ cmd.exe

Les commandes `cmd.exe` classiques (`rmdir /s /q`, `rd`, …) n'existent pas nativement en PowerShell et provoquent des erreurs `ParameterBindingException` confuses. Utilisez les équivalents PowerShell :

| cmd.exe | PowerShell |
|---------|------------|
| `rmdir /s /q .venv` | `Remove-Item -Recurse -Force .venv` |
| `del fichier` | `Remove-Item fichier` |
| `copy a b` | `Copy-Item a b` |

#### 5. Une installation Python de base corrompue casse tout silencieusement

Si vous rencontrez `ModuleNotFoundError: No module named 'pip'`, un avertissement `Ignoring invalid distribution ~ip`, ou si `import pywintypes` échoue systématiquement même après un postinstall qui semble réussi (DLL copiées, mais import introuvable), votre installation Python de base (pas le venv) est corrompue — généralement un reliquat de mise à jour `pip` interrompue. Les symptômes se propagent à **tous** les venvs créés à partir de cette installation. Solution : désinstallez complètement Python, réinstallez-le proprement depuis [python.org](https://www.python.org/downloads/) (cochez "Add python.exe to PATH", évitez la version Microsoft Store), puis recréez tous les venvs du projet (racine **et** `apps/backend`).

### Configuration des Providers AI

#### Authentification Claude (Recommandé)
```bash
claude
# Tapez : /login
# Appuyez sur Entrée pour ouvrir le navigateur
```
*Le token est automatiquement sauvegardé dans le Keychain OS*

#### Configuration Multi-Providers
| Provider | Méthode | Configuration |
|----------|---------|---------------|
| **Anthropic Claude** | OAuth ou API Key | `ANTHROPIC_API_KEY` |
| **OpenAI** | API Key | `OPENAI_API_KEY` |
| **Google Gemini** | API Key | `GOOGLE_API_KEY` |
| **Grok / xAI** | API Key | `XAI_API_KEY` |
| **Ollama** | Endpoint local | `OLLAMA_BASE_URL` |
| **GitHub Copilot** | OAuth | Via interface |
| **Azure OpenAI** | API Key + Endpoint | `AZURE_OPENAI_*` |

#### Variables d'Environnement Optionnelles
```bash
# .env-files/.env
AUTO_BUILD_MODEL=claude-opus-5
DEBUG=true
LINEAR_API_KEY=votre_clé_linear
GRAPHITI_ENABLED=true
```

### Configuration du Projet

#### Structure de Projet Requise
```
votre-projet/
├── .git/                # Obligatoire : dépôt Git initialisé
├── package.json         # Pour projets Node.js
├── requirements.txt     # Pour projets Python
├── Cargo.toml           # Pour projets Rust
└── ...                  # Vos fichiers de code
```

#### Détection Automatique de Stack
WorkPilot AI détecte automatiquement :
- **Framework** : React, Vue, Angular, Django, Flask, Express
- **Language** : TypeScript, JavaScript, Python, Rust, Go
- **Build Tools** : Vite, Webpack, Cargo, Poetry
- **Testing** : Jest, Pytest, Vitest, Playwright

### Validation de l'Installation

#### Tests de Connexion
```bash
# Tests du frontend (vitest)
pnpm test

# Tests du backend (pytest)
pnpm run test:backend

# Suite complète (pré-push)
pnpm run test:all
```

#### Vérification de l'Environnement
```bash
# Version Node.js
node --version  # >= v20

# Version Python
python --version  # 3.12+

# Configuration Claude
claude --version
```

### Hooks Git

Les hooks sont volontairement **rapides**. La CI (`ci.yml`, `lint.yml`) rejoue la suite complète sur Linux, Windows et macOS à chaque push sur `main`/`develop` : la redoubler en local coûte plusieurs minutes à chaque commit sans rien garantir de plus.

| Étage | Ce qui tourne | Budget |
|-------|---------------|--------|
| `pre-commit` | ruff + biome **sur les fichiers stagés uniquement**, puis les tests liés à ces fichiers | quelques secondes |
| `pre-push` | ruff check, ruff format --check, biome lint | < 30 s |
| CI | pytest, typecheck, vitest, build — sur 3 OS | — |

Le typecheck est **incrémental** (`incremental` + `tsBuildInfoFile` dans `apps/frontend/tsconfig.json`) : la première passe reste longue, les suivantes tombent à quelques secondes.

#### Jouer la suite complète en local

```bash
PRE_PUSH_FULL=1 git push        # ajoute pytest, typecheck et vitest au pre-push
pnpm run test:all               # ou directement, sans pousser
```

#### Contourner (dépannage)

| Besoin | Commande |
|--------|----------|
| Sauter tous les hooks d'un commit | `git commit --no-verify` |
| Sauter le pre-push | `git push --no-verify` |
| Garder le lint, sauter les tests au commit | `PRE_COMMIT_SKIP_TESTS=1 git commit …` |
| Laisser plus de temps à un check lent | `PRE_PUSH_TIMEOUT_MS=900000 git push` (15 min) |
| Refuser le push si un check expire | `PRE_PUSH_STRICT=1 git push` |

Chaque job du pre-push a un **timeout** (5 min par défaut) : un check qui part en vrille est tué au lieu de bloquer le push indéfiniment, et un point d'avancement s'affiche toutes les 20 s. Un timeout avertit sans bloquer — la CI reste le garde-fou.

> ⚠️ **Gardez ruff aligné sur la CI** (`ruff==0.15.7`, voir `.github/workflows/lint.yml`). Une version plus récente reformate le code Python contenu dans les blocs ```` ```python ```` des fichiers `.md`, ce qui produit des dizaines de fichiers modifiés sans rapport avec votre travail :
> ```bash
> pip install "ruff==0.15.7"
> ```

### Dépannage Courant

#### Problèmes d'Installation
- **Node.js non trouvé** : Réinstallez depuis https://nodejs.org avec "Add to PATH"
- **Modules natifs** : `pnpm run rebuild` dans `apps/frontend`
- **Python manquant** : Installez Python 3.12+ et ajoutez au PATH

#### Problèmes Python / venv (Backend)

> Sur Windows, la plupart des soucis Python (pywin32, venv, installation de base corrompue, syntaxe PowerShell) sont couverts en détail dans **[Notes Spécifiques Windows](#notes-spécifiques-windows)**. Résumé rapide :
> - `pywin32` "non installé" malgré une installation réussie → réinstallez-le en ciblant explicitement le python **du venv**, sur les **deux** venvs du projet (racine et `apps/backend`)
> - `import pywintypes` échoue encore après le postinstall → supprimez et recréez le venv à neuf plutôt que de patcher
> - `ModuleNotFoundError: No module named 'pip'` / `Ignoring invalid distribution ~ip` → installation Python de base corrompue, réinstallez Python entièrement
> - `Remove-Item : Impossible de trouver un paramètre positionnel...` → vous utilisez une syntaxe `cmd.exe` (`rmdir /s /q`) en PowerShell ; utilisez `Remove-Item -Recurse -Force .venv`

- **`PermissionError: [Errno 13]` en écriture sur `apps/frontend/.env-files/.env`, alors que la lecture fonctionne et que les permissions NTFS semblent correctes**
  Le fichier a probablement été créé par un run précédent avec élévation UAC (propriétaire `BUILTIN\Administrateurs` visible via `Get-Acl`) et porte une étiquette d'intégrité qui bloque l'écriture par un process non-admin, invisible dans l'ACL classique. Le plus simple est de le supprimer pour qu'il se régénère proprement :
  ```powershell
  Remove-Item "apps\frontend\.env-files\.env" -Force
  ```
  Voir aussi **Notes Spécifiques Windows → point 2** pour désactiver l'élévation UAC elle-même (`WORKPILOT_NO_ELEVATE=1`).

- **`Error: An Application Control policy has blocked this file` sur un `.node` dans `node_modules` pendant `electron-vite dev`**
  Smart App Control (Windows 11) ou une politique WDAC bloque le chargement d'un binaire natif npm non reconnu. Voir **Notes Spécifiques Windows → point 3** pour vérifier l'état et désactiver (PC personnel) ou faire autoriser le fichier par votre IT (PC d'entreprise).

#### Problèmes d'Authentification
- **Token Claude expiré** : `claude` puis `/login`
- **API Key invalide** : Vérifiez les variables d'environnement
- **Problèmes OAuth** : Révoquez et réautorisez l'application

#### Problèmes de Performance
- **Mémoire insuffisante** : Fermez les applications inutiles
- **Timeout réseau** : Vérifiez votre connexion internet
- **Lenteur UI** : Redémarrez l'application

---

## Project Structure

```
WorkPilot-AI/
├── apps/
│   ├── backend/     # Python agents, specs, QA pipeline, integrations
│   └── frontend/    # Electron desktop application (React + TypeScript)
├── src/             # Shared Python connectors (provider config, LLM discovery)
├── config/          # Provider registry and shared configuration
├── docs/            # Documentation and guides
├── shared_docs/     # Long-form reference docs (configuration, architecture)
├── tests/           # Python test suite
└── scripts/         # Build, release, and maintenance utilities
```

---

## CLI Usage

For headless operation, CI/CD integration, or terminal-only workflows:

```bash
cd apps/backend
python runners/spec_runner.py --interactive   # Create a spec interactively
python run.py --spec 001                      # Run autonomous build
python run.py --spec 001 --review             # Review
python run.py --spec 001 --merge              # Merge
```

See [docs/CLI-USAGE.md](docs/CLI-USAGE.md) for the full CLI reference.

---

## Security

WorkPilot AI uses a three-layer security model:

1. **OS Sandbox** — Bash commands run in isolation
2. **Filesystem Restrictions** — Operations limited to project directory
3. **Dynamic Command Allowlist** — Only approved commands based on detected project stack

All releases include SHA256 checksums and VirusTotal scans.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Installation et Configuration](#installation-et-configuration) | Requirements, install methods, provider setup |
| [Dépannage Courant](#dépannage-courant) | Common issues and fixes |
| [Configuration Reference](shared_docs/CONFIGURATION.md) | Provider registry, credential resolution, env vars |
| [CLI Usage](docs/CLI-USAGE.md) | Headless / CI usage |
| [Contributing](docs/CONTRIBUTING.md) | Code style, testing, PR process |
| [Linux Guide](docs/linux.md) | Flatpak, AppImage builds |
| [Windows Development](docs/windows-development.md) | Windows-specific encoding and tooling notes |
| [Release Process](docs/RELEASE.md) | How releases are cut and published |
| [Security Policy](docs/SECURITY.md) | Supported versions, reporting a vulnerability |

---

## Contributing

We welcome contributions! Please read [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) for development setup, code style, testing requirements, and PR process.

### Syncing with Upstream

WorkPilot AI tracks the upstream [Auto-Claude](https://github.com/AndyMik90/Auto-Claude) project. To pull upstream changes into your fork:

```bash
pnpm merge-upstream                 # merge upstream/develop and push
pnpm merge-upstream -- --skip-push  # review before publishing
pnpm run validate:upstream          # check the sync tooling is wired up
```

Platform wrappers are in `utils/system/`, and `.github/workflows/sync-upstream.yml` runs the same merge on a schedule. See [Keeping Your Fork Updated](docs/CONTRIBUTING.md#keeping-your-fork-updated) for details.

---

## Community

- **Issues** — [Report bugs or request features](https://github.com/krovomi/WorkPilot-AI/issues)
- **Discussions** — [Ask questions](https://github.com/krovomi/WorkPilot-AI/discussions)

---

## License

**AGPL-3.0** — GNU Affero General Public License v3.0

WorkPilot AI is free to use. If you modify and distribute it, or run it as a service, your code must also be open source under AGPL-3.0. Commercial licensing available for closed-source use cases.

---

## Star History

[![GitHub Repo stars](https://img.shields.io/github/stars/krovomi/WorkPilot-AI?style=social)](https://github.com/krovomi/WorkPilot-AI/stargazers)

[![Star History Chart](https://api.star-history.com/svg?repos=krovomi/WorkPilot-AI&type=Date)](https://star-history.com/#krovomi/WorkPilot-AI&Date)
