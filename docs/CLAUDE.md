# Carte normative et justifications de conception

Les **règles critiques** sont dans [`../AGENTS.md`](../AGENTS.md), le seul fichier que tous les agents
lisent (Claude Code par l'import de `CLAUDE.md`). Les règles détaillées sont dans [`rules/`](rules/) ;
les deux sont **normatifs**. Les `AGENTS.md` locaux sont des index : ils disent où regarder, pas ce qui
est permis. En cas de désaccord, la règle gagne et l'index est à corriger.

Claude Code charge ce fichier quand il lit un fichier de `docs/` ; les autres agents y arrivent par lien.

## Où vit chaque chose

| Besoin | Fichier | Chargé |
|---|---|---|
| Règles qui valent partout | [`../AGENTS.md`](../AGENTS.md) | toujours, par tous les agents |
| Sécurité | [`rules/security.md`](rules/security.md) | en lisant `apps/backend/security/`, `apps/backend/server/`, `apps/frontend/src/main/`, `.github/workflows/` ; sinon à la demande |
| Python, agents, clients LLM, tests backend | [`rules/backend.md`](rules/backend.md) | en lisant `apps/backend/` |
| Electron, React, IPC, i18n | [`rules/frontend.md`](rules/frontend.md) | en lisant `apps/frontend/` |
| Commandes, hooks, branches, CI, release | [`rules/workflow.md`](rules/workflow.md) | en lisant `.github/workflows/` ; sinon à la demande |
| Pourquoi une feature est construite ainsi | [`architecture/`](architecture/), table ci-dessous | à la demande |
| Fichiers d'instructions par agent | [`architecture/agent-instructions.md`](architecture/agent-instructions.md) | à la demande |
| Toute la documentation | [`README.md`](README.md) | à la demande |

## Justifications de conception (`architecture/`)

Pourquoi chaque feature est construite ainsi. Lire le fichier avant de modifier la feature ; ce
fichier-ci reste l'autorité sur les règles.

| Feature | Fichier | Contenu |
|---|---|---|
| Vue produit | [product-overview.md](architecture/product-overview.md) | Les features, et une ligne par vue de l'app (`SidebarView`), vérifiée par `tests/test_product_overview_views.py` ; une vue sans conception ni test y est marquée expérimentale, comme dans la barre latérale. |
| Fichiers d'instructions | [agent-instructions.md](architecture/agent-instructions.md) | Un seul jeu de règles (`AGENTS.md`, critiques et payées à chaque session), un fichier fin par agent (Claude, Copilot, Gemini CLI, Codex…) ; les providers de la boucle WorkPilot (OpenAI, Grok, DeepSeek, Mistral, Gemini API, locaux) reçoivent le `AGENTS.md` du projet dans leur prompt. |
| Prompts d'agents | [agent-prompts.md](architecture/agent-prompts.md) | Quel prompt de `apps/backend/prompts/` sert quel agent. |
| Droits d'outils | [agent-tool-rights.md](architecture/agent-tool-rights.md) | Une liste d'outils déclarée est un droit des deux côtés : `disallowed_tools` du SDK, garde de l'exécuteur, sandbox Codex. |
| Secrets au repos | [secrets-at-rest.md](architecture/secrets-at-rest.md) | Clés et jetons de l'app chiffrés par `safeStorage`, trousseau Linux sans bureau déclaré (WSL), avertissement sans trousseau, migration, redaction des logs Electron ; le `.env` de projet et celui du backend : jetons chiffrés, clés lues par le backend nommées ; âge de chaque clé, daté au changement de valeur, rappel à 90 jours. |
| Pipeline de spec | [spec-pipeline.md](architecture/spec-pipeline.md) | Reprise de plan, traçabilité `FR-###`, `[NEEDS CLARIFICATION]`, constitutions spec-kit. |
| Skills | [skills.md](architecture/skills.md) | `skills/` est la source, `scripts/skills_cli.py` le seul écrivain ; frontmatter lu par `parse_frontmatter` ; gate 4 : un corps qui s'adresse à l'agent n'est pas émis. |
| hermes-agent | [hermes.md](architecture/hermes.md) | Ingestion, tri et adoption des skills d'hermes, et `SOUL.md`. Rien n'accorde la confiance à la place de quelqu'un. |
| pi (pi.dev) | [pi.md](architecture/pi.md) | Plan par lots, lots 0 à 5 livrés (le 5 en partie) : harness qui n'émet rien (pi lit `AGENTS.md` et `.agents/skills/`), provider `PiCliAgentClient` en `--mode json` puis RPC, droits par `--tools` depuis `harnesses.yaml`, confiance (`/trust`) jamais accordée à la place d'une personne, agent du cerveau. |
| Agents ACP | [acp.md](architecture/acp.md) | Un client Agent Client Protocol pour tous les agents qui le parlent (Gemini CLI d'abord), une entrée `acp:` par agent dans `providers.yaml` ; droits tenus trois fois (mode, question refusée, tour arrêté), `session/request_permission` posée sur la carte, capacités montrées seulement si déclarées. |
| Spécification par l'exemple | [spec-by-example.md](architecture/spec-by-example.md) | ASP.NET Core : les critères d'acceptation écrits en tests d'intégration HTTP avant le code ; Python vérifie qu'ils ne touchent que les projets de test, compilent et échouent, puis pose `dotnet test` en objectif avec ces tests protégés ; un objectif posé par la personne reste le sien. |
| Revue croisée | [cross-review.md](architecture/cross-review.md) | Après la QA, un autre fournisseur relit le diff contre la spec et l'objectif et répond agree, disagree ou inconclusive ; un désaccord qui nomme un problème bloquant retient la PR tant que le code n'a pas changé ou que la personne ne passe pas outre ; une réponse illisible n'est jamais un accord. |
| Règles issues des revues | [review-lessons.md](architecture/review-lessons.md) | Un fil de revue corrigé par le suivi de PR ou le retour d'un plan rejeté devient une règle candidate ; seule une personne l'adopte, et seule une règle adoptée entre dans les prompts, à chaque phase. Hors du cerveau tant qu'elle n'est pas adoptée (S2). |
| Cerveau partagé et mémoire | [brain.md](architecture/brain.md) | La seule mémoire : vault Obsidian, `graph.json`, serveur MCP, mémoire des builds, `mem-search`. |
| Génération de tests | [test-generation.md](architecture/test-generation.md) | Où les tests générés sont écrits (`test_generation/layout.py`) et avec quelles bibliothèques. |
| libdocs | [libdocs.md](architecture/libdocs.md) | Pages Context7 des bibliothèques sans exemple dans le dépôt, avant le build. |
| Catalogues de modèles | [model-catalog.md](architecture/model-catalog.md) | Découverte des modèles Codex et registre models.dev derrière les sélecteurs. |
| docintel | [docintel.md](architecture/docintel.md) | Pièces jointes, diagrammes, moteurs OCR, redaction des secrets, ADR, traces de pile, ERD, QA visuelle. |
| rtk | [rtk.md](architecture/rtk.md) | Sortie de commande condensée pour les modèles seulement ; l'allowlist voit à travers le proxy. |
| watermarks | [watermarks.md](architecture/watermarks.md) | Caractères invisibles retirés des fichiers générés dans un hook PreToolUse ; `old_string` n'est jamais touché. |
| ui-ux-pro-max | [uiux.md](architecture/uiux.md) | Design system et règles de pile, seulement sur les tâches qui touchent une interface. |
| archify | [archify.md](architecture/archify.md) | Cartes d'architecture et deltas par tâche ; la continuité des identifiants est la contrainte. |
| Applications mobiles | [mobile.md](architecture/mobile.md) | Détection de pile, appareils, chaîne d'outils ; iOS seulement sur macOS. |
| Boucle de vérification | [verify.md](architecture/verify.md) | Lancer l'app, corriger, confirmer l'état, mesurer, garder la preuve ; une app Windows (WPF, WinForms, WinUI) pilotée par UI Automation dans la seule fenêtre que la carte nomme, sans souris ni clavier ; un scénario web écrit sur la carte, suivi dans Playwright, capturé étape par étape et tracé, jamais un succès s'il n'est pas allé au bout. |
| Traces GenAI | [genai-traces.md](architecture/genai-traces.md) | Spans `gen_ai.*` pour chaque AgentClient ; jamais de contenu ; usage non remonté estimé, jamais 0. |
| MCP 2026 : tasks et Apps | [mcp-2026.md](architecture/mcp-2026.md) | `ToolServer` répond dans les deux ères et ne rend une tâche qu'à un client qui la déclare (`verify_*` longs) ; le client de la boucle WorkPilot attend, annule, borne la tâche ; les vues MCP Apps sont gardées dans la spec et affichées dans une iframe `allow-scripts` sans `allow-same-origin`, servies par un schéma du main avec leur propre CSP. |
| Kanban en MCP | [board-mcp.md](architecture/board-mcp.md) | `workpilot-board` sert les cartes d'un projet à un agent en terminal : lister, lire, créer au backlog, attendre une colonne (tâche MCP) ; aucun outil ne lance un build, n'approuve un plan ni ne fusionne, aucun ne prend de chemin. |
| Suivi de la PR | [pr-followup.md](architecture/pr-followup.md) | La carte fait avancer sa PR jusqu'au merge : check rouge ou fil de revue au QA fixer, commit vérifié (aucun test sauté, aucune CI modifiée), push jamais forcé ; une forge illisible n'est jamais du vert, un échec rouge aussi sur la base n'est pas « corrigé ». |
| Mode serveur | [server-mode.md](architecture/server-mode.md) | Une équipe sur un même serveur : identité, organisation et rôles, groupes de personnes qui ajoutent un rôle d'organisation et des rôles de projet sans jamais en retirer ni passer d'un tenant à l'autre, projets clonés, tableau partagé (cartes créées, modifiées, supprimées, approuvées par `project_id`), projets du serveur dans l'app (ajout par URL de dépôt, tableau lu par instantané dans un miroir que rien n'exécute, vues limitées, cartes créées, modifiées, supprimées, lancées et arrêtées par le serveur sous un id `server:<projet>:<carte>`, revues, fusionnées et proposées en PR depuis l'espace de build du serveur, tableau suivi en direct par une WebSocket du main, jeton en en-tête), features partagées (roadmap, idéation) : fichiers d'une liste fermée réécrits depuis l'empreinte lue (409 sinon), runner lancé en job sur le clone, confiné et sous quota, suivi par l'app comme un processus local, feature ou idée faite carte du tableau par le serveur, runs lancés sur le serveur sans entrée standard ni `--force`, confinés par Landlock à leur clone, au home de leur projet et à leur dossier temporaire (`WORKPILOT_RUN_ISOLATION`, refus plutôt qu'un run ouvert) ; le flux en direct ouvert aux seuls membres du projet (`project:<id>`, `run:<id>`), le jeton d'un run ne nommant que lui ; l'environnement d'un run construit sans les variables du serveur. |
| Bac à sable de l'OS | [os-sandbox.md](architecture/os-sandbox.md) | Processus d'agent sous bubblewrap (Linux) ou Seatbelt (macOS) : écritures dans le worktree, identifiants masqués, réseau par un proxy filtrant (provider + registres) ; sans bac à sable la carte le dit au lancement, `WORKPILOT_SANDBOX=required` refuse de démarrer ; Windows pas encore. |
| Best-of-N | [best-of-n.md](architecture/best-of-n.md) | Une tâche construite N fois, une variante par moteur ; classement chiffré, choix humain, rien de fusionné. |
| Variantes et rejeux | [variants-and-replays.md](architecture/variants-and-replays.md) | ADR : `best_of_n` est le seul mécanisme de variantes (`parallel_variations`, jamais monté, supprimé) ; `replay` (enregistrement des sessions) et `bench` (cartes rejouées et notées) restent séparés ; un fork de Time Travel est enregistré, jamais exécuté, et ne prend plus de clé. |
| Mode objectif | [goal-mode.md](architecture/goal-mode.md) | Une commande dit « fini » : chemins protégés, plafond de passes et de dépense, fichier qu'aucun agent n'écrit. |
| Besoin de toi | [needs-you.md](architecture/needs-you.md) | Notifications lues dans XState ; ntfy, Telegram ; approbation d'un plan par jeton à usage unique. |
| Automatisations | [automations.md](architecture/automations.md) | Un événement (issue étiquetée, CI rouge sur la base, horaire) crée une carte du Kanban, en brouillon par défaut, dédoublonnée, sous plafond du jour ; une PR ouverte par quelqu'un d'autre reçoit la revue de GitHub PRs, jamais publiée par la règle ; remplace le démon `continuous_ai`. |
| Bounty Board | [bounty-board.md](architecture/bounty-board.md) | Concours notés sur artefacts ; une preuve absente renormalise, ne vaut jamais zéro. |
| Délégation aux sous-agents | [delegation.md](architecture/delegation.md) | `native` (Claude), `emulated` (outil `delegate` + session enfant du même client sur la boucle WorkPilot), `none` (CLI) ; le scope d'un enfant ne s'élargit jamais. |
| Moteur d'agents comme port | [agent-runtime.md](architecture/agent-runtime.md) | `agent_runtime` : un Protocol que `core` installe à l'import ; merge, intégrations, analyse et architecture lancent leur session par lui au lieu d'importer `core` ou `agents` ; aucun client en plus, chaque appel va à la fabrique de `core`. |
| Types de tâche Kanban | [kanban-task-types.md](architecture/kanban-task-types.md) | Plan par lots ; livrés : le type (`bug_fix`, `hotfix`, `run`, `investigation`…) décidé sans token (lot 0), un workflow YAML par type choisi par `workflows/registry.py`, `fallback:` substitué et affiché, `tests-unchanged` (lot 1), BMAD par `impl` + `fallback` là où il est documentaire, jugé installé dans le projet cible, `when: kind == … and complexity == …` (lot 2), RUN exécuté par Python derrière une pause avant l'irréversible, journal expurgé, environnements déclarés (lot 3). À venir : rosters et prompts par type, origine → type, mesure. |
| Workflows déclaratifs | [workflows.md](architecture/workflows.md) | `workflow.yaml`, élagage par effort, fenêtres, rosters, passage de phase ; le logger de workflow. |
| Pause et reprise | [pause-resume.md](architecture/pause-resume.md) | `foundation/pause_state.py`, `BuildPaused` / `BuildHalted`, reprendre une phase sans la payer deux fois. |
| Gestion du contexte | [context-management.md](architecture/context-management.md) | Artefacts sobres (un fait, un endroit) et politique compact / clear par tâche, native ou émulée. |
| Harness de contexte | [context-harness.md](architecture/context-harness.md) | Plan par lots, indépendant du provider ; livrés : la mesure de chaque appel dans une unité commune (lot 0), un budget par session, un arrêt sur absence de progrès et une seule boucle WorkPilot pour tous (lots 1a, 1b-i, 1b-ii), un préfixe ordonné du plus stable au plus volatil (lot 2), la troncature à la source : lecture et recherche par pages, sorties longues déversées dans un fichier relisible, cerveau paginé (lot 3), la purge par lots et la fenêtre payable (lot 4), ce qu'un sous-agent rend, borné et marqué, et leur lancement échelonné (lot 5), un jeu d'outils trié et figé par session (lot 6), des extraits de code classés à la demande par `search_code`, servis en MCP et dans les boucles WorkPilot (lot 7), des sessions enregistrées rejouées à chaque PR contre une base : préfixe, composition, budgets, taux de hit (lot 8, sans la campagne avec LLM). |
| Mode hors-ligne | [offline-mode.md](architecture/offline-mode.md) | `airgapStrict` comme barrière, sinon comme défaut. |
| Architecture frontend | [frontend-architecture.md](architecture/frontend-architecture.md) | Stores, activité de fond et barre latérale, agents, profils, terminaux, liens d'auth. |
| Panneau de tâche | [frontend-task-panel.md](architecture/frontend-task-panel.md) | Progression (`shared/progress.ts`), onglet Overview, critères d'acceptation, graphe des changements. |
| Moteur de tâche et LLM de page | [task-engine.md](architecture/task-engine.md) | Une tâche possède son provider × LLM × effort par phase ; une page résout le sien par `page-llm.ts`. |
| Visual-to-code | [visual-to-code.md](architecture/visual-to-code.md) | Documents d'architecture et leur historique sur disque. |
| Émulateur d'app | [app-emulator.md](architecture/app-emulator.md) | Adresse d'arrivée déduite du diff, barre d'adresse, ouverture dans le navigateur. |
| Mode Arena | [arena.md](architecture/arena.md) | De vrais concurrents (provider, modèle) et un coût mesuré. |
| Banc de rejeu | [repo-bench.md](architecture/repo-bench.md) | Cartes terminées rejouées depuis le commit d'avant, par moteur, dans des copies sans la réponse ; jugées par les tests du commit d'arrivée, calibrés (F2P/P2P) ; le tableau nourrit Formula Lab et le routeur, et recommande par type de carte le moteur le moins cher proche du meilleur taux, proposé sur l'étape moteur, jamais appliqué seul. |
| Outils de développement | [dev-tools.md](architecture/dev-tools.md) | MCP Electron pour l'E2E, Chrome DevTools MCP, grepai. |
| Dépannage | [troubleshooting.md](architecture/troubleshooting.md) | Problèmes courants et où regarder. |

Une nouvelle feature dont la conception mérite d'être expliquée : un fichier dans `architecture/` et
une ligne ici (`tests/test_docs_context.py` le vérifie).
