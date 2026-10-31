# AGENTS.md — index du backend

Python 3.12+, FastAPI sur `127.0.0.1:9000`, WebSocket sur `:8765`. Une centaine de paquets de
premier niveau ; ce fichier donne ceux qui comptent.

> Règles (normatif) : [`docs/rules/backend.md`](../../docs/rules/backend.md), sécurité :
> [`docs/rules/security.md`](../../docs/rules/security.md) · Racine : [`../../AGENTS.md`](../../AGENTS.md)

## Le chemin critique

Toute interaction LLM passe par ces fichiers ; les modifier touche tout le produit.

| Fichier | Lignes | Rôle |
|---|---|---|
| `core/client.py` | ~3 100 | **la fabrique** : `create_client()` (SDK Claude), `create_agent_client()` (multi-provider) ; modèle, outils, MCP, sous-agents, hooks de sécurité, une fonction par sujet sous `create_client`, un constructeur par provider sous `create_agent_client` |
| `core/simple_client.py` | — | client sans hooks, refusé aux types qui écrivent ou exécutent |
| `core/agent_clients/` | ~6 800 | un module par provider (`claude`, `copilot`, `openai`, `google`, `compatible`, `local`, `windsurf`, les CLI `opencode_cli`, `antigravity_cli`, `pi_cli` sur `cli_subprocess`, `acp` le client Agent Client Protocol commun à tous les agents ACP et `acp_permissions` qui pose leurs questions sur la carte, `pi_guard/` le garde-fou chargé dans pi…) ; `core/agent_client.py` les réexporte |
| `core/worktree.py` + `worktree_pr.py` + `worktree_common.py` | ~3 450 | worktrees par spec ; la création de PR/MR est le mixin `WorktreePRMixin` |
| `agents/session.py` | ~2 500 | boucle de session : streaming, reprise, erreurs, rate limits ; l'affichage d'un appel d'outil (fil d'activité, vue streaming) vit dans `agents/tool_display.py` |
| `agents/coder.py` | ~2 950 | l'agent d'implémentation : `run_autonomous_agent` (la boucle, ~1 150 lignes), les prompts de planification et de sous-tâche (`_planning_prompt`, `_coding_prompt`), l'issue d'une session (`_on_session_error` et un `_on_*` par type d'erreur, `_RetryState`), le plan invalide, le bilan de fin |
| `cli/build_commands.py` | ~1 300 | enchaîne les phases d'un build : planning → coding → QA |
| `qa/loop.py` | ~1 600 | boucle de validation QA : `run_qa_validation_loop` et une fonction par session, gate et verdict |
| `provider_api.py` | ~2 050 | point d'entrée FastAPI : monte les routeurs, CORS, redaction des logs |

## Couches

`foundation/` est la couche la plus basse et n'importe rien du backend : `platform/`,
`api_safety.py`, `file_utils.py`, `git_executable.py`, `phase_event.py`, `dotnet_tools.py`,
`codex_catalog_rpc.py`, `vendor_manifest.py`, `workpilot_layout.py`, `ci_logs.py` (parseurs de
journaux de CI, partagés par `self_healing`, `docintel` et `verify`), `traceability.py`
(identifiants `FR-###` et couverture du plan), `paging.py`. `core/` est la racine de
composition, qui importe les agents. Les autres modules sortis de `core` par le lot M10 :
`offline_policy/` (avec `local_model_catalog.py`), `app_detection.py` (détecteur de l'aperçu),
`project/ui_stack.py` et `project/test_stack.py` (les piles UI et de test, venues de `uiux` et de
`test_generation`). `agent_runtime/` est le port par lequel une unité que `core` importe lance
une session sans importer `core` ni `agents` (merge, intégrations, analyse, architecture,
génération de tests ;
[justification](../../docs/architecture/agent-runtime.md)) ; `core/agent_runtime.py` l'installe.
`tests/test_import_contracts.py` tient ces frontières.

## Modèle, effort, routage

| Fichier | Contenu |
|---|---|
| `phase_config.py` | `MODEL_ID_MAP`, `THINKING_BUDGET_MAP`, `DEFAULT_PHASE_MODELS`, `PROVIDER_DEFAULT_MODELS`, `get_phase_model()`, `get_phase_thinking_budget()` |
| `models_registry.py` | catalogue livré des modèles et de leurs capacités |
| `model_router/router.py` | `TaskClass` × `QualityTier` (budget / balanced / premium) → modèle ; écarte un modèle que le banc de rejeu a vu échouer |
| `bench/` | banc de rejeu ([justification](../../docs/architecture/repo-bench.md)) : cartes terminées rejouées depuis leur commit d'avant dans des copies isolées, jugées par les tests du commit d'arrivée (calibrés F2P / P2P), tableau par provider × modèle × effort lu par Formula Lab et `model_router/`, recommandations par type de carte (`recommendations`) ; commandes : `runners/bench_runner.py` |
| `foundation/phase_event.py` | événements de phase vers l'UI |
| `foundation/pause_state.py`, `foundation/build_signals.py` | pause coopérative ; `BuildPaused` / `BuildHalted` |
| `context_mgmt/` | fenêtre de contexte par session : jauge, compact / clear au seuil |
| `harness/` | harness de contexte ([plan](../../docs/architecture/context-harness.md)) : `harness/domain/` mesure chaque appel dans une unité commune à tous les providers et le chiffre (`harness/domain/usage.py`, `harness/domain/ledger.py`, `harness/domain/cost.py`), ordonne un prompt du segment le plus stable au plus volatil (`harness/domain/layout.py`), pagine ce que lisent les outils ou déverse ce qui ne se relit pas (`foundation/paging.py`), purge les vieux résultats d'outils par lots (`harness/domain/policies.py`), arrête un modèle qui se répète (`harness/domain/progress.py`), borne et marque ce que rend un sous-agent (`harness/domain/subagents.py`) et fige un jeu d'outils trié par session, qu'il pèse (`harness/domain/tools.py`) ; `harness/application/budget.py` plafonne chaque session, `harness/application/subagents.py` délimite ce résultat comme une donnée et lance les sous-agents en échelon, `harness/domain/delegation.py` et `harness/application/delegation.py` donnent un roster à tout provider de la boucle (outil `delegate`, session enfant du même client, [justification](../../docs/architecture/delegation.md)), `harness/application/tools.py` pose le jeu d'outils sur chaque client WorkPilot et pèse chaque type d'agent ; `harness/domain/evals.py` juge une session rejouée (cache par capacité, régressions contre une base) et `harness/application/replay.py` la rejoue dans le code de production (fixtures : `tests/harness/replay/`) ; `harness/application/loop.py` est la seule boucle WorkPilot, derrière `harness/ports.py` (`ModelPort`), et `harness/domain/stop.py` dit quand elle s'arrête ; ses adaptateurs restent dans `core/agent_clients/` (`LoopAdapter`) ; `harness/domain/code_chunks.py` et `harness/domain/code_ranking.py` découpent le code par symbole et le classent (BM25 + RRF), `harness/application/code_search.py` l'indexe et répond à `search_code`, que `harness/tools/` sert en MCP (`workpilot-code`) et à `ToolExecutor` |

## Agents, sous-agents, skills

| Chemin | Rôle |
|---|---|
| `agents/tools_pkg/models.py` | `AGENT_CONFIGS` : les outils de chaque type d'agent |
| `subagents/__init__.py` | `resolve` : le roster servi à un `agent_type` ; un dict `agents` passé par l'appelant gagne |
| `subagents/phases.py` | sous-agents par défaut par phase |
| `subagents/languages/` | overlays par langage (.NET, Python, TypeScript, Java, Go, Rust) |
| `subagents/pr_review.py` | relecteurs de PR, prompts sous `prompts/github/` |
| `prompts/` | les prompts système réels (une quarantaine, dont `github/`) |
| `skills_registry/frontmatter.py` | **le** parseur de frontmatter |
| `skills_registry/agents.py` | émet le registre de sous-agents vers chaque harness |
| `skills_registry/acquire.py`, `upstream.py`, `classify.py` | `skills-cli add/update/remove`, provenance par tree SHA, classement des releases amont |
| `skills_registry/injection_gate.py` | gate 4 du resolver : un corps de skill qui s'adresse à l'agent n'est pas émis |
| `slash_commands/api.py` | sert `.agents/skills/*/SKILL.md` à la barre de commandes du Kanban |
| `skills/` | skills Python exécutables ([index](skills/AGENTS.md)) |

## Sécurité et mode serveur

| Chemin | Rôle |
|---|---|
| `security/` | allowlist de commandes, écritures confinées, contenu non fiable ([index](security/AGENTS.md)) |
| `injection_guard/` | scanner d'injection de prompt |
| `server/auth/`, `server/authz/` | authentification (JWT, OIDC) ; permissions, rôles, tenants, portée de projet, canaux du flux en direct (`ws_channels.py`) ; conception : [`server-mode.md`](../../docs/architecture/server-mode.md) |
| `shared_board/` | les cartes du tableau partagé d'un projet serveur : créer, lire, modifier, supprimer, approuver |
| `foundation/api_safety.py` | chemins acceptés par l'API locale |
| `offline_policy/` | hors-ligne strict (`airgapStrict`) |
| `os_sandbox/` | bac à sable de l'OS autour des commandes d'agent : bubblewrap, Seatbelt, proxy filtrant ([conception](../../docs/architecture/os-sandbox.md)) |
| `foundation/log_redaction.py` | filtre de redaction des logs |

## Mémoire, apprentissage, autonomie

| Paquet | Rôle |
|---|---|
| `brain/` | le cerveau partagé : vault Obsidian, `graph.json`, sync git, serveur MCP `workpilot-brain` |
| `brain/project_memory.py` | **la seule mémoire** des builds (pièges, conventions, sessions) |
| `mem_search/` | lecture de la mémoire par paliers (index → timeline → détail) |
| `cross_review/` | verdict de la revue croisée : lecture, enregistrement, `blocking_verdict` qui retient la PR d'un code avec lequel le second fournisseur est en désaccord ; feuille sur `foundation`. La phase `cross-review` elle-même (choix du moteur, session) est `workflows/cross_review_phase.py` |
| `learning_loop/` | patterns des builds, phase `observe` (`skills/_proposed/`), replay A/B ; `review_lessons.py` : règles candidates des revues, adoptées par une personne |
| `hermes/` | hermes-agent : doctor, persona `SOUL.md`, cycle d'apprentissage |
| `core/merge_event.py` | un merge publié une fois ; mémoire, apprentissage et `uiux` s'y abonnent |
| `foundation/workpilot_layout.py` | un dossier par feature sous `.workpilot/` |
| `self_healing/` | boucle autonome avec plafond de coût ; surveillance et remédiation (les automatisations, qui créent des cartes sur un événement, vivent côté Electron : `apps/frontend/src/main/automations/`) |

## Préparer et vérifier un build

| Paquet | Rôle |
|---|---|
| `tasks/` | le **type** d'une carte (`bug_fix`, `hotfix`, `run`, `investigation`…) décidé sans modèle (`classify.py`) et écrit dans `task_metadata.json` (`metadata.py`) ; lot 0 de [kanban-task-types.md](../../docs/architecture/kanban-task-types.md) |
| `workflows/` | le moteur des workflows déclaratifs : `spec.py` (le YAML, `fallback`, `irreversible`), `registry.py` (type de carte → `workflows/<nom>/workflow.yaml`), `engine.py` (élagage, dégradation, substitution par `fallback` jugée dans le projet cible), `task_facts.py` (type et complexité lus pour `when:`), `runner.py` (fenêtres, phases de skill, `irreversible_gate`), `runbook.py` / `execute.py` / `environments.py` (la procédure d'un RUN lue, jouée par Python derrière l'allowlist, journalisée ; environnements déclarés), `handoff.py` (le rapport d'une phase au prochain lecteur, selon le workflow du type), `hard_gates.py` (`tests-pass`, `app-verified`, `tests-unchanged`), `api.py` ; [justification](../../docs/architecture/workflows.md) |
| `project/stack.py` | **la** détection de pile (langages, frameworks, type d'app, marqueurs) |
| `libdocs/` | docs des bibliothèques sans exemple dans le dépôt, avant le planning |
| `docintel/` | pièces jointes : diagrammes, OCR (`engines/`), PDF, ERD, séquences, C4, tableaux, captures ; `redact.py` masque les secrets |
| `rtk/` | sortie de commande condensée avant lecture par un modèle |
| `watermarks/` | caractères invisibles retirés de chaque fichier généré |
| `uiux/` | design system et règles de pile UI, seulement si la tâche touche l'interface |
| `mobile/` | Android / Apple : piles, appareils, `readiness.py` (constructible ici ?) |
| `verify/` | boucle `/verify` : lancer l'app, erreurs → correction, preuve ; une app Windows (`window.py`, assistant `uia/driver.ps1`) se lit et se conduit par UI Automation dans une seule fenêtre, nommée par la carte, de l'arbre de processus lancé ; le scénario écrit sur la carte (`scenario.py`, `verifyScenario`) est suivi dans Playwright, étape par étape, avec captures et trace (`scenario-trace.zip`) |
| `genai_trace/` | spans OpenTelemetry GenAI de chaque `AgentClient` (`invoke_agent`, `chat`, `execute_tool`), posés par `AgentClient.__init_subclass__` ; aucun contenu ; une feuille, importée par `harness` ([justification](../../docs/architecture/genai-traces.md)) |
| `mcp_tasks/` | MCP 2026-07-28 pour les serveurs de WorkPilot : `ToolServer` (deux ères), `TaskStore` (extension Tasks) ; feuille. Côté client : `core/mcp_extensions.py` ([conception](../../docs/architecture/mcp-2026.md)) |
| `board_mcp/` | serveur MCP `workpilot-board` : le Kanban d'un projet pour un agent en terminal (lister, lire, créer au backlog, attendre une colonne) ; ni lancement, ni approbation, ni merge ; runner `runners/board_mcp.py` ([conception](../../docs/architecture/board-mcp.md)) |
| `pr_followup/` | la PR d'une tâche suivie jusqu'au merge : `policy.decide` (pure), gardes du diff de correctif, GitHub par `gh`, `run_round` ; runner `runners/pr_followup_runner.py` ([justification](../../docs/architecture/pr-followup.md)) |
| `best_of_n/` | best-of-N : variantes d'une tâche (une par moteur), classement chiffré, adoption de la variante choisie ([best-of-n.md](../../docs/architecture/best-of-n.md)) |
| `goal/` | mode objectif : une commande et son code de sortie disent « fini » ; chemins protégés, plafond de dépense ([goal-mode.md](../../docs/architecture/goal-mode.md)) |
| `architecture_visualizer/` | carte archify du projet et delta par tâche |
| `bounty_board/` | N modèles sur une spec, preuves mesurées, juge anonyme |
| `vendor/archify/`, `vendor/watermarks/` | code vendorisé et épinglé (`scripts/vendor_*.py`) |

## Imports et tests

Imports plats depuis la racine du backend (`from phase_config import …`) ; tests dans
`../../tests/<paquet>/`, une seule configuration (`pytest.ini` à la racine) ; aucun test ne vit
ici. Cinq modules de production portent seulement le préfixe `test_` (`regression_guardian/test_generator.py`,
`analysis/test_discovery.py`…) : `apps/backend` reste dans `testpaths` pour eux seuls, car
`tests/test_test_discovery.py` exige que tout `test_*.py` soit collecté ; ils ne produisent aucun test.

À la racine du backend restent des modules propres (`phase_config.py`, `models_registry.py`,
`provider_selection.py`, le provider choisi dans l'UI, lu sans importer l'API) et des
points d'entrée lancés par chemin ou par uvicorn (`run.py`, `start_backend.py`, `provider_api.py`,
`analyzer.py`, `commit_message.py`) ; `insight_extractor.py` est un réexport en sursis.
Les dépendances entre unités de premier niveau sont gardées par `tests/test_import_contracts.py`
(règle dans [`backend.md`](../../docs/rules/backend.md#code-python)).
