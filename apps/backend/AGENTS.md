# AGENTS.md — index du backend

Python 3.12+, FastAPI sur `127.0.0.1:9000`, WebSocket sur `:8765`. Une centaine de paquets de
premier niveau ; ce fichier donne ceux qui comptent.

> Règles (normatif) : [`docs/rules/backend.md`](../../docs/rules/backend.md), sécurité :
> [`docs/rules/security.md`](../../docs/rules/security.md) · Racine : [`../../AGENTS.md`](../../AGENTS.md)

## Le chemin critique

Toute interaction LLM passe par ces fichiers ; les modifier touche tout le produit.

| Fichier | Lignes | Rôle |
|---|---|---|
| `core/client.py` | ~2 750 | **la fabrique** : `create_client()` (SDK Claude), `create_agent_client()` (multi-provider) ; modèle, outils, MCP, sous-agents, hooks de sécurité |
| `core/simple_client.py` | — | client sans hooks, refusé aux types qui écrivent ou exécutent |
| `core/agent_clients/` | ~6 800 | un module par provider (`claude`, `copilot`, `openai`, `google`, `compatible`, `local`, `windsurf`…) ; `core/agent_client.py` les réexporte |
| `core/worktree.py` + `worktree_pr.py` + `worktree_common.py` | ~3 450 | worktrees par spec ; la création de PR/MR est le mixin `WorktreePRMixin` |
| `agents/session.py` | ~2 500 | boucle de session : streaming, reprise, erreurs, rate limits |
| `agents/coder.py` | ~2 700 | l'agent d'implémentation, découpage en sous-tâches |
| `cli/build_commands.py` | ~1 300 | enchaîne les phases d'un build : planning → coding → QA |
| `qa/loop.py` | ~1 350 | boucle de validation QA |
| `provider_api.py` | ~2 050 | point d'entrée FastAPI : monte les routeurs, CORS, redaction des logs |

## Modèle, effort, routage

| Fichier | Contenu |
|---|---|
| `phase_config.py` | `MODEL_ID_MAP`, `THINKING_BUDGET_MAP`, `DEFAULT_PHASE_MODELS`, `PROVIDER_DEFAULT_MODELS`, `get_phase_model()`, `get_phase_thinking_budget()` |
| `models_registry.py` | catalogue livré des modèles et de leurs capacités |
| `model_router/router.py` | `TaskClass` × `QualityTier` (budget / balanced / premium) → modèle |
| `core/phase_event.py` | événements de phase vers l'UI |
| `core/pause_state.py`, `core/build_signals.py` | pause coopérative ; `BuildPaused` / `BuildHalted` |
| `context_mgmt/` | fenêtre de contexte par session : jauge, compact / clear au seuil |
| `harness/` | harness de contexte ([plan](../../docs/architecture/context-harness.md)) : `harness/domain/` mesure chaque appel dans une unité commune à tous les providers et le chiffre (`harness/domain/usage.py`, `harness/domain/ledger.py`, `harness/domain/cost.py`), ordonne un prompt du segment le plus stable au plus volatil (`harness/domain/layout.py`), pagine ce que lisent les outils ou déverse ce qui ne se relit pas (`harness/domain/paging.py`), purge les vieux résultats d'outils par lots (`harness/domain/policies.py`) et arrête un modèle qui se répète (`harness/domain/progress.py`) ; `harness/application/budget.py` plafonne chaque session |

## Agents, sous-agents, skills

| Chemin | Rôle |
|---|---|
| `agents/tools_pkg/models.py` | `AGENT_CONFIGS` : les outils de chaque type d'agent |
| `agents/subagents/__init__.py` | `resolve` : le roster servi à un `agent_type` ; un dict `agents` passé par l'appelant gagne |
| `agents/subagents/phases.py` | sous-agents par défaut par phase |
| `agents/subagents/languages/` | overlays par langage (.NET, Python, TypeScript, Java, Go, Rust) |
| `agents/subagents/pr_review.py` | relecteurs de PR, prompts sous `prompts/github/` |
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
| `server/auth/`, `server/authz/` | authentification (JWT, OIDC) ; permissions, rôles, tenants, portée de projet |
| `core/api_safety.py` | chemins acceptés par l'API locale |
| `core/offline_policy.py` | hors-ligne strict (`airgapStrict`) |
| `core/log_redaction.py` | filtre de redaction des logs |

## Mémoire, apprentissage, autonomie

| Paquet | Rôle |
|---|---|
| `brain/` | le cerveau partagé : vault Obsidian, `graph.json`, sync git, serveur MCP `workpilot-brain` |
| `brain/project_memory.py` | **la seule mémoire** des builds (pièges, conventions, sessions) |
| `mem_search/` | lecture de la mémoire par paliers (index → timeline → détail) |
| `learning_loop/` | patterns des builds, phase `observe` (`skills/_proposed/`), replay A/B |
| `hermes/` | hermes-agent : doctor, persona `SOUL.md`, cycle d'apprentissage |
| `core/merge_event.py` | un merge publié une fois ; mémoire, apprentissage et `uiux` s'y abonnent |
| `core/workpilot_layout.py` | un dossier par feature sous `.workpilot/` |
| `continuous_ai/daemon.py`, `self_healing/` | boucles autonomes avec plafond de coût ; surveillance et remédiation |

## Préparer et vérifier un build

| Paquet | Rôle |
|---|---|
| `project/stack.py` | **la** détection de pile (langages, frameworks, type d'app, marqueurs) |
| `libdocs/` | docs des bibliothèques sans exemple dans le dépôt, avant le planning |
| `docintel/` | pièces jointes : diagrammes, OCR (`engines/`), PDF, ERD, séquences, C4, tableaux, captures ; `redact.py` masque les secrets |
| `rtk/` | sortie de commande condensée avant lecture par un modèle |
| `watermarks/` | caractères invisibles retirés de chaque fichier généré |
| `uiux/` | design system et règles de pile UI, seulement si la tâche touche l'interface |
| `mobile/` | Android / Apple : piles, appareils, `readiness.py` (constructible ici ?) |
| `verify/` | boucle `/verify` : lancer l'app, erreurs → correction, preuve |
| `architecture_visualizer/` | carte archify du projet et delta par tâche |
| `bounty_board/` | N modèles sur une spec, preuves mesurées, juge anonyme |
| `vendor/archify/`, `vendor/watermarks/` | code vendorisé et épinglé (`scripts/vendor_*.py`) |

## Imports et tests

Imports plats depuis la racine du backend (`from phase_config import …`) ; tests dans
`../../tests/<paquet>/`, une seule configuration (`pytest.ini` à la racine) ; aucun test ne vit
ici. Six modules de production portent seulement le préfixe `test_` (`agents/test_generator.py`,
`analysis/test_discovery.py`…) : `apps/backend` reste dans `testpaths` pour eux seuls, car
`tests/test_test_discovery.py` exige que tout `test_*.py` soit collecté ; ils ne produisent aucun test.

À la racine du backend restent des modules propres (`phase_config.py`, `models_registry.py`) et des
points d'entrée lancés par chemin ou par uvicorn (`run.py`, `start_backend.py`, `provider_api.py`,
`analyzer.py`, `commit_message.py`) ; `insight_extractor.py` est un réexport en sursis.
