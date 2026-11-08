# Architecture de WorkPilot AI

> Pour une lecture guidée — y compris sans prérequis technique — ouvrez l'atlas
> [`docs/audit/WorkPilot-architecture.html`](audit/WorkPilot-architecture.html) (vue « Pour tous »,
> schémas cliquables, constats, feuille de route ; un fichier par constat depuis F113 dans
> [`docs/audit/findings/`](audit/findings/)). Les justifications de conception sont dans
> [`docs/architecture/`](architecture/).
>
> Les liens entre couches sont vérifiés par des tests qui lisent les sources : IPC dans les deux
> sens et canaux nommés par constante (`ipc-channel-parity.test.ts`), imports entre unités du
> backend et plafond du cycle principal, ramené de 81 à 10 unités par la couche `foundation/` et le port `agent_runtime`
> (`tests/test_import_contracts.py`), une ligne par vue dans
> [`product-overview.md`](architecture/product-overview.md) (`tests/test_product_overview_views.py`).
>
> Une vue qui n'a encore ni document de conception ni test est marquée expérimentale dans la
> barre latérale (une fiole sur le coin de son icône). Un bouton en bas de la barre les masque toutes. Chaque script de
> [`scripts/`](../scripts/README.md) a sa ligne dans le README du dossier.

## Vue d'Ensemble

WorkPilot AI est une application de bureau autonome basée sur une architecture multi-agents qui orchestre le cycle de vie complet du développement logiciel. Le système combine un backend Python puissant avec une interface utilisateur Electron moderne pour offrir une expérience de développement transparente.

## Architecture Multi-Agents

### Pipeline Autonome de Développement
1. **Agent Planner** - Analyse la complexité et décompose les tâches en sous-tâches
2. **Agent Coder** - Implémente les fonctionnalités avec des sous-agents parallèles
3. **Agent QA Reviewer** - Valide les implémentations selon les critères d'acceptation
4. **Agent QA Fixer** - Résout automatiquement les problèmes identifiés

C'est le parcours d'une **fonctionnalité** (`workflows/feature-build/workflow.yaml`). Le **type de la
carte** — décidé sans modèle à la création de la spec (`apps/backend/tasks/classify.py`), affiché et
modifiable sur la carte — choisit le workflow réellement joué (`apps/backend/workflows/registry.py`) :

| Type | Workflow | Ce qui change |
|---|---|---|
| `feature` (ou type inconnu) | `feature-build` | le parcours ci-dessus ; `prd` BMAD sur une feature complexe à `ultrathink` |
| `bug_fix` | `bug-fix` | `reproduce` d'abord (le test rouge, la cause probable), pas de brainstorm ni de carte d'architecture |
| `hotfix` | `hotfix` | `reproduce`, revue indépendante à tout effort, pas de préflight de docs |
| `investigation` | `investigation` | un rapport (`investigate`, lecture seule) et **aucun code** ; le coder n'est pas lancé |
| `run` | `run` | la procédure écrite (`runbook`), relue par une personne, puis jouée par Python derrière l'allowlist après une pause avant l'irréversible ; journal `workflow/run.md`, environnements déclarés dans `.workpilot/environments.toml` |
| `refactoring` | `refactoring` | gate `tests-unchanged` : le diff ne touche aucun test |
| `test` | `test` | plan, tests écrits en TDD, revue, suite verte |
| `docs` | `docs` | le document, relu contre le code (`proofread`), sans boucle QA |
| `spike` | `spike` | approches comparées, prototype jetable, `verdict` |

Détail et plan par lots : [`docs/architecture/kanban-task-types.md`](architecture/kanban-task-types.md).

### Agents Spécialisés
- **Test Generator** - Génération de tests unitaires et d'intégration
- **Refactorer** - Refactoring sécurisé du code avec détection de patterns
- **Documenter** - Génération automatique de documentation
- **Migration Agent** - Migration de frameworks et bibliothèques
- **Memory Manager** - Le cerveau partagé : un vault Obsidian lu et écrit par tous les agents

### Sous-agents spécialisés
Les sous-agents ne sont pas déclarés par chaque agent : ils vivent dans **un seul registre**,
[`apps/backend/subagents/`](../apps/backend/subagents/), et chaque session reçoit un
*roster* composé par `subagents.resolve()` depuis `core/client.py` :

1. **Défauts de phase** (`phases.py`) — p. ex. coder : `code-reviewer`, `test-runner`,
   `architecture-analyst` ; planner : `architecture-analyst`, `dependency-tracer` ;
   QA : `qa-acceptance-checker`, `test-runner` ; revue : `security-auditor`, `regression-hunter`,
   `test-coverage-auditor` ; les appels d'une seule réponse (message de commit…) n'en ont aucun.
2. **Overlays de langage** (`languages/` : .NET, Python, TypeScript, Java, Go, Rust) — la pile
   détectée injecte ses commandes (`dotnet test --nologo`…) dans le prompt du `test-runner`.
3. **Overlay mobile** — ajoute `device-runner` et `store-readiness-auditor` sur une app mobile.
4. **Agents fournis par l'appelant** — gagnent toujours (relecteurs de PR de `pr_review.py`).
5. **Plafond** de 7 sous-agents.

Le roster atteint le modèle sur tout provider (`capabilities/providers.yaml`) :
- `native` — Claude : `agents=` du SDK et son outil `Agent` ;
- `emulated` — Copilot, OpenAI, Gemini, Ollama / LM Studio, Mistral, DeepSeek, Grok, Windsurf :
  un outil `delegate` dont la description liste les spécialistes, et une **session enfant** du même
  client par délégation, avec les seuls outils du spécialiste et un résultat borné
  ([`docs/architecture/delegation.md`](architecture/delegation.md)) ;
- `none` — les CLI (Codex, OpenCode, Antigravity, pi) apportent leurs outils et ne reçoivent pas de roster.

Ce que rend un sous-agent est borné et traité comme une donnée non fiable
(`harness/application/subagents.py`). Le même registre, plus les personas des packs
(`skills/dotnet/agents/net-architect.md`, `skills/mobile/agents/…`), est émis dans
`.agents/agents/` pour les IDE (Copilot, Codex, Claude Code) ; ces personas de pack ne font pas
partie des rosters du pipeline. Détail : [`apps/backend/agents/README.md`](../apps/backend/agents/README.md#subagents).

### Méthode BMAD
BMAD est une **capacité à la demande**, jamais une étape obligatoire : 50 skills BMAD v6.12.0
vendorisés dans [`skills/bmad/`](../skills/bmad/) par `scripts/vendor_bmad.py`. Ils ont besoin du
runtime `_bmad/` que l'installeur BMAD écrit **dans le projet cible** (`pnpm run skills:bootstrap
--pack bmad`) ; sans lui, ils sont masqués de la barre de commandes. Dans les workflows, BMAD
n'entre que là où sa valeur est documentaire — `brainstorm` (`bmad-brainstorming`), le `prd` d'une
feature complexe à `ultrathink` (`bmad-prd`), la recherche d'un spike (`bmad-deep-recon`) — et
toujours avec un `fallback:` WorkPilot que le moteur substitue quand le projet n'a pas le runtime,
en l'écrivant dans le profil. Voir [`skills/README.md`](../skills/README.md#runtime-gates) et
[`docs/architecture/kanban-task-types.md`](architecture/kanban-task-types.md).

## Architecture Technique

### Backend Python (`apps/backend/`)
```
apps/backend/
├── core/                # Racine de composition : fabrique de clients, authentification, worktree
│   ├── client.py        # Client Claude Agent SDK
│   ├── agent_clients/   # Un client par provider (OpenAI, Gemini, Copilot, Ollama, pi, ACP…)
│   ├── effort_plan.py   # L'effort réellement envoyé à chaque provider
│   ├── auth.py          # Gestion multi-profils OAuth
│   └── worktree.py      # Isolation des espaces de travail Git
├── foundation/          # Couche la plus basse, n'importe rien du backend (platform/, api_safety, git)
├── agents/              # Logique d'exécution des agents
│   ├── planner.py       # Agent de planification
│   ├── coder.py         # Agent de développement
│   └── session.py       # Gestion des sessions
├── subagents/           # Registre des sous-agents, seule source (phases, langages, mobile, revue de PR)
├── harness/             # Harness de contexte : budgets, pagination, résultats des sous-agents
├── skills_registry/     # Build des skills et émission des agents vers les harnesses
├── workflows/           # Moteur des workflows déclaratifs (workflows/*/workflow.yaml)
├── qa/                  # Pipeline de validation QA
│   ├── reviewer.py      # Validation des critères
│   ├── fixer.py         # Résolution automatique
│   └── loop.py          # Boucle de validation
├── runners/             # Points d'entrée (spec_runner, github, gitlab, azure_devops, un runner par vue)
├── spec/                # Création et gestion des specs
├── cli/                 # Interface ligne de commande
├── context/             # Construction du contexte des tâches
├── services/            # Services d'intégration externes
├── integrations/        # Connecteurs (Azure DevOps, Linear, JEV, Windsurf) ; Jira et grepai dans src/connectors/
├── project/             # Analyse et détection de projets
├── merge/               # Système de fusion sémantique
├── verify/              # Boucle de vérification : lancer l'app, lire les erreurs, prouver (web, mobile, API, UI Automation, scénario Playwright)
├── pr_followup/         # La carte suit sa PR : checks rouges et fils de revue → QA fixer
├── goal/                # Mode objectif : une commande dit « fini »
├── best_of_n/           # Une tâche construite N fois, classée sur des chiffres
├── bench/               # Banc de rejeu des cartes terminées, tableau par provider
├── os_sandbox/          # bubblewrap / Seatbelt autour des commandes d'agent
├── genai_trace/         # Spans OpenTelemetry GenAI pour tous les providers
├── mcp_tasks/           # MCP 2026-07-28 : tasks côté serveurs WorkPilot
├── board_mcp/           # Serveur MCP workpilot-board : le Kanban depuis le terminal
├── self_healing/        # Surveillance de santé + auto-réparation
├── tech_debt/           # Suivi et résolution de la dette technique
├── consensus_arbiter/   # Arbitrage des avis d'agents (sécurité/QA)
├── agent_coach/         # Conseils coût/modèle basés sur l'usage réel
├── carbon_profiler/     # Empreinte énergie/carbone des exécutions
├── release_coordinator/ # Préparation des releases
├── flaky_test_detective/# Détection des tests instables
├── streaming/           # Diffusion temps réel des sessions d'agents
├── server/              # Mode serveur multi-utilisateurs (auth, claims)
└── prompts/             # Prompts système réels des agents (~50, dont github/)
```

> Le backend compte **près de 120 paquets** (accessibilité, dérive d'architecture, gouvernance de licences, orchestration multi-repo, etc.). Voir [apps/backend/README.md](../apps/backend/README.md) et la [table des modules du wiki](https://github.com/krovomi/WorkPilot-AI/wiki) pour l'inventaire complet auto-généré.

### Frontend Electron (`apps/frontend/`)
```
apps/frontend/src/
├── main/                # Processus principal Electron
│   ├── agent/           # Gestion des files d'attente
│   ├── claude-profile/  # Gestion multi-profils
│   ├── terminal/        # Daemon PTY et cycle de vie
│   ├── platform/        # Abstraction cross-plateforme
│   ├── security/        # Politiques IPC : expéditeur, dossiers, chemins d'outils et du backend
│   ├── automations/     # Règles qui créent une carte (issue étiquetée, CI rouge, horaire) ou relisent une PR en brouillon
│   ├── needs-you/       # Notifications bureau, ntfy, Telegram ; approbation de plan à distance
│   ├── mcp-apps/        # Vues MCP Apps servies au panneau de tâche (workpilot-mcp-app://)
│   ├── ipc-handlers/    # 200+ modules de gestion IPC
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

## Flux de Données et État

### Flux d'Exécution des Agents
1. **Création de Tâche** → Utilisateur crée une tâche dans l'UI/CLI
2. **Génération de Spec** → L'AI analyse la complexité et crée une spécification
3. **Phase de Planification** → Le Planner décompose en sous-tâches
4. **Implémentation** → Le Coder exécute avec des sous-agents parallèles
5. **Validation QA** → Le Reviewer valide l'implémentation
6. **Résolution des Problèmes** → Le Fixer résout les problèmes identifiés
7. **Phase de Fusion** → Fusion sémantique vers la branche principale

### Gestion d'État
- **État Projet** → [`main/project-store.ts`](../apps/frontend/src/main/project-store.ts)
- **État Tâche/Spec** → [`renderer/stores/task-store.ts`](../apps/frontend/src/renderer/stores/task-store.ts)
- **État Terminal** → [`renderer/stores/terminal-store.ts`](../apps/frontend/src/renderer/stores/terminal-store.ts)
- **État Agent** → [`main/agent/agent-state.ts`](../apps/frontend/src/main/agent/agent-state.ts)
- **État Paramètres** → [`renderer/stores/settings-store.ts`](../apps/frontend/src/renderer/stores/settings-store.ts)

## Sécurité et Isolation

### Modèle de Sécurité à 3 Couches
1. **Sandbox OS** → Commandes d'agent sous bubblewrap (Linux) ou Seatbelt (macOS) : écritures dans le worktree, identifiants cachés, réseau filtré ; sans bac à sable (Windows), la carte le dit, et `WORKPILOT_SANDBOX=required` refuse de démarrer
2. **Restrictions Filesystem** → Opérations limitées au répertoire projet
3. **Allowlist Dynamique** → Commandes approuvées selon la stack détectée

### Gestion des Credentials
- **Système de Profils Claude** → Gestion OAuth multi-comptes
- **Stockage Secure** → Keychain OS / Credential Manager
- **Âge des clés** → Réglages > Comptes dit depuis quand chaque clé d'API est enregistrée, rappel après 90 jours
- **Rotation Automatique** → Cycle de vie des tokens OAuth
- **Validation Input** → Chemins et commandes sanitizées
- **Aucun secret dans le renderer** → L'interface sait qu'une clé ou un jeton est configuré, jamais sa valeur ; les tests de connexion tournent dans le main
- **Frontière renderer → main** → Seule la page de l'app atteint un handler IPC. Un chemin reçu de l'interface est résolu (liens compris) et doit être dans un projet enregistré ou un dossier choisi dans une boîte de dialogue ; l'interface ne choisit jamais l'exécutable lancé, et un chemin d'outil ou du backend saisi dans les réglages est vérifié avant d'être exécuté

## Performance et Scalabilité

### Modèle de Concurrence
- **Parallélisme d'Agents** → Jusqu'à 12 terminaux AI parallèles
- **Opérations Async** → I/O non-bloquant partout
- **Pooling de Ressources** → Connexions et sessions réutilisées
- **Load Balancing** → Switching automatique multi-comptes

### Optimisations
- **Optimisation Tokens** → Compression et cache du contexte
- **Gestion Mémoire** → Cleanup agressif et checkpoints
- **Optimisation Réseau** → Pooling de connexions et retries
- **Performance UI** → Virtual scrolling et lazy loading
