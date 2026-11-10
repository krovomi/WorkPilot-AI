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
| Fichiers d'instructions | [agent-instructions.md](architecture/agent-instructions.md) | Un seul jeu de règles (`AGENTS.md`), un fichier fin par agent ; la boucle WorkPilot injecte le `AGENTS.md` du projet. |
| Prompts d'agents | [agent-prompts.md](architecture/agent-prompts.md) | Quel prompt de `apps/backend/prompts/` sert quel agent. |
| Droits d'outils | [agent-tool-rights.md](architecture/agent-tool-rights.md) | Une liste d'outils déclarée est un droit des deux côtés : `disallowed_tools` du SDK, garde de l'exécuteur, sandbox Codex. |
| Secrets au repos | [secrets-at-rest.md](architecture/secrets-at-rest.md) | Clés et jetons chiffrés par `safeStorage` (trousseau WSL déclaré), logs Electron caviardés ; `.env` de projet et du backend : jetons chiffrés ; âge de chaque clé, rappel à 90 jours. |
| Garde des résultats d'outils | [tool-result-guard.md](architecture/tool-result-guard.md) | Chaque résultat d'outil scanné avant le modèle (`run_tool` des boucles, hook `PostToolUse` Claude) : suspect encadré, bloqué retenu en mode `block` ; sources de confiance écrites par main seul ; alertes sans contenu. |
| Pipeline de spec | [spec-pipeline.md](architecture/spec-pipeline.md) | Reprise de plan, traçabilité `FR-###`, `[NEEDS CLARIFICATION]`, constitutions spec-kit. |
| Skills | [skills.md](architecture/skills.md) | `skills/` est la source, `scripts/skills_cli.py` le seul écrivain ; frontmatter lu par `parse_frontmatter` ; gate 4 : un corps qui s'adresse à l'agent n'est pas émis. |
| hermes-agent | [hermes.md](architecture/hermes.md) | Ingestion, tri et adoption des skills d'hermes, et `SOUL.md`. Rien n'accorde la confiance à la place de quelqu'un. |
| pi (pi.dev) | [pi.md](architecture/pi.md) | Harness qui n'émet rien (pi lit `AGENTS.md`, `.agents/skills/`), `PiCliAgentClient` en `--mode json` puis RPC, droits par `--tools`, `/trust` jamais accordé à la place d'une personne. |
| Agents ACP | [acp.md](architecture/acp.md) | Un client ACP pour tous les agents qui le parlent, une entrée `acp:` par agent dans `providers.yaml` ; droits tenus trois fois, `session/request_permission` posée sur la carte. |
| Spécification par l'exemple | [spec-by-example.md](architecture/spec-by-example.md) | ASP.NET Core : critères d'acceptation en tests d'intégration HTTP avant le code, vérifiés (projets de test seuls, compilent, échouent) puis protégés sous l'objectif `dotnet test`. |
| Paliers de QA | [qa-tiers.md](architecture/qa-tiers.md) | Légère (texte seul), ciblée (≤ 3 fichiers de code, ≤ 150 lignes, un test par fichier : seuls ces tests tournent, sans sous-agent), complète ; tout doute donne la complète. |
| Agent i18n | [i18n-agent.md](architecture/i18n-agent.md) | Toutes stacks, sans modèle : clé proposée au style du projet, orphelines, recopies, variables, pluriels CLDR, RTL ; traduction vérifiée sur carte de revue. |
| Re-revue QA par delta | [qa-recheck.md](architecture/qa-recheck.md) | Après un rejet, la passe suivante vérifie d'abord les issues contre le delta du fixer (lu dans git, snapshot en objet tree sans toucher au worktree) et les tests des fichiers touchés, et rejette tôt ; la passe qui approuve reste la revue complète. |
| Revue croisée | [cross-review.md](architecture/cross-review.md) | Après la QA, un autre fournisseur relit le diff contre la spec : agree, disagree ou inconclusive ; un désaccord bloquant retient la PR jusqu'à un code changé ou un passer outre ; illisible n'est jamais un accord. |
| Porte de mutation `tests-bite` | [mutation-gate.md](architecture/mutation-gate.md) | Fautes plantées une à une dans les lignes de la tâche (toutes stacks), dans une copie jetable du worktree ; suite rouge, sans commande ou trop lente = « inconnu », jamais vert ; survivants au fixer comme tests manquants, ses fichiers non-test restaurés. |
| Red team | [red-team.md](architecture/red-team.md) | Tests d'attaque écrits dans une copie jetable, lancés par WorkPilot ; plantage = erreur de programmation dont la trace nomme un fichier changé, sinon « inattendu », non bloquant ; échec non reproduit = instable ; passes suivantes rejouées sans modèle. |
| Tests instables | [flaky-tests.md](architecture/flaky-tests.md) | Verdict par taux, cause lue dans le code du test (toutes stacks), historique local, relance des seuls suspects par le filtre de la stack ; carte pour corriger ou mettre en quarantaine. |
| Garde des dépendances | [dependency-guard.md](architecture/dependency-guard.md) | Paquets ajoutés depuis la base, toutes stacks, vus sur leur registre public ; seul un 404 sans autre source bloque ; registre muet ou flux privé = « inconnu » ; nom proche d'un paquet populaire averti. |
| Garde-fous en code | [guardrails.md](architecture/guardrails.md) | Lue du projet principal (worktrees compris), couches globale → `workpilot.policy.yaml` → `.workpilot/guardrails.*` sans affaiblir ; chemins relatifs ; tests supprimés, dépendance ajoutée (toutes stacks) ; invalide = refus ; approbation unique. |
| Vérification des preuves | [proof-checks.md](architecture/proof-checks.md) | Vérificateurs `[proofs]` lancés dans le worktree après la QA ; seul un refus renvoie au fixer ; absent ou hors délai = « inconnu ». |
| Garde des migrations | [schema-guard.md](architecture/schema-guard.md) | Le `up` des migrations de la tâche, toutes stacks, sans modèle ni base : perte de données, renommage, NOT NULL sans défaut, ancienne migration modifiée = erreur ; verrou, type, pas de `down` = alerte ; bloque en `strict`. |
| Conformité aux standards | [standards.md](architecture/standards.md) | Les versions de MCP, ACP, AGENTS.md et OTel GenAI que parle le code, et ce qui atteint chaque provider (champ `standards` de `providers.yaml`) ; chaque affirmation est vérifiée contre le client qui tourne, `unverified` n'est jamais lu comme un support. |
| Attribuer les lignes écrites par l'IA | [agent-trace.md](architecture/agent-trace.md) | Un *trace record* Agent Trace v0.1 par session de coder dans `agent-trace.jsonl`, plages tirées de `git diff` (tous providers) ; non-commité = `human`, introuvable = `unknown`, jamais devinée ; ni prompt ni code ; ne fait jamais échouer un build. |
| Point des tâches longues | [task-digest.md](architecture/task-digest.md) | Un point à intervalle fixe sur les canaux de notification existants, lu dans les fichiers de la tâche seulement ; désactivé par défaut, jamais avant un intervalle, et un build repris attend la fin de l'intervalle en cours. |
| Tâches empilées | [stacked-tasks.md](architecture/stacked-tasks.md) | Parent = prérequis non terminé, sans boucle ; l'enfant part du commit local du parent ; « Mettre à jour » rebase `--onto` hors agent et sur worktree propre, un conflit est annulé ; parent fusionné : l'enfant passe sur sa base, PR reciblée ; `gh stack` si installé. |
| Exigence → fichiers → tests | [requirement-links.md](architecture/requirement-links.md) | `requirement_trace/` en fin de build : chaque exigence reliée aux fichiers de ses sous-tâches (Agent Trace, sinon le plan) et à leurs tests (conventions de toutes les stacks), gardée dans `.workpilot/requirements/` après la tâche ; jamais deviné. |
| Dossier de provenance d'une PR | [provenance.md](architecture/provenance.md) | `provenance/` : attribution, dépendances ajoutées, SBOM CycloneDX du diff, portes et vérification d'une PR, `null` quand la source manque ; résumé dans la PR ; ni code ni prompt. |
| Preuves de conformité | [compliance-evidence.md](architecture/compliance-evidence.md) | Preuves datées (tâches, git, config) ; contrôles en YAML, ceux du projet compris ; rapport mensuel, alerte à 30 jours, sans modèle. |
| Chirurgien de l'historique Git | [git-history-surgeon.md](architecture/git-history-surgeon.md) | Plan par règles (fix-ups dans une même partie, convention, découpe), rejeu sur une nouvelle branche aux fichiers identiques ; jamais de push. |
| Release Train | [release-train.md](architecture/release-train.md) | Lance les commandes du fichier approuvé (empreinte gardée hors du projet) par vagues ; santé et smoke entre services, clic par service en prod, rollback en cascade. |
| Épinglage des outils MCP | [mcp-pins.md](architecture/mcp-pins.md) | Un serveur MCP personnalisé n'expose que les outils approuvés, épinglés par l'empreinte de ce que lit le modèle ; ajout ou description changée retenus ; injoignable = jamais exposé. |
| Règles issues des revues | [review-lessons.md](architecture/review-lessons.md) | Un fil de revue corrigé par le suivi de PR ou le retour d'un plan rejeté devient une règle candidate ; seule une personne l'adopte, et seule une règle adoptée entre dans les prompts, à chaque phase. Hors du cerveau tant qu'elle n'est pas adoptée (S2). |
| Cerveau partagé et mémoire | [brain.md](architecture/brain.md) | La seule mémoire : vault Obsidian, `graph.json`, serveur MCP, mémoire des builds, `mem-search`. |
| Changelog | [changelog.md](architecture/changelog.md) | Notes de version depuis les tâches terminées ou git ; serveur : job sur le clone, un appel `core.oneshot`, requête fermée. |
| Génération de tests | [test-generation.md](architecture/test-generation.md) | Où les tests générés sont écrits (`test_generation/layout.py`) et avec quelles bibliothèques. |
| libdocs | [libdocs.md](architecture/libdocs.md) | Pages Context7 des bibliothèques sans exemple dans le dépôt, avant le build. |
| Catalogues de modèles | [model-catalog.md](architecture/model-catalog.md) | Découverte des modèles Codex et registre models.dev derrière les sélecteurs. |
| docintel | [docintel.md](architecture/docintel.md) | Pièces jointes, diagrammes, moteurs OCR, redaction des secrets, ADR, traces de pile, ERD, QA visuelle. |
| rtk | [rtk.md](architecture/rtk.md) | Sortie de commande condensée pour les modèles seulement ; l'allowlist voit à travers le proxy. |
| watermarks | [watermarks.md](architecture/watermarks.md) | Caractères invisibles retirés des fichiers générés dans un hook PreToolUse ; `old_string` n'est jamais touché. |
| ui-ux-pro-max | [uiux.md](architecture/uiux.md) | Design system et règles de pile, seulement sur les tâches qui touchent une interface. |
| archify | [archify.md](architecture/archify.md) | Cartes d'architecture et deltas par tâche ; la continuité des identifiants est la contrainte. |
| Applications mobiles | [mobile.md](architecture/mobile.md) | Détection de pile, appareils, chaîne d'outils ; iOS seulement sur macOS. |
| Migrations .NET 8 → 11 / C# 15 | [dotnet-upgrade.md](architecture/dotnet-upgrade.md) | Skills de migration 8 → 9, 9 → 10, 10 → 11 adaptées de dotnet/skills, une étape par version, copiées dans la spec des seules tâches qui en ont besoin, lisibles par tous les providers. |
| Boucle de vérification | [verify.md](architecture/verify.md) | Lancer l'app, corriger, confirmer, mesurer, garder la preuve ; Windows par UI Automation, web par Playwright (trace, vidéo, GIF sur demande), jamais un succès inachevé ; rejeu sur la base pour lister ce qui change. |
| Traces GenAI | [genai-traces.md](architecture/genai-traces.md) | Spans `gen_ai.*` pour chaque AgentClient ; jamais de contenu ; usage non remonté estimé, jamais 0. |
| MCP 2026 : tasks et Apps | [mcp-2026.md](architecture/mcp-2026.md) | `ToolServer` dans les deux ères, tâche seulement au client qui la déclare ; vues MCP Apps en iframe `allow-scripts` sans `allow-same-origin`, avec CSP. |
| Marketplaces MCP et plugins | [marketplaces.md](architecture/marketplaces.md) | Un serveur MCP installé va dans `CUSTOM_MCP_SERVERS` du projet ; un plugin écrit son skill dans `.agents/skills/` et `.claude/skills/`, marqué, jamais sur un skill étranger ; serveurs vérifiés à la source. |
| Kanban en MCP | [board-mcp.md](architecture/board-mcp.md) | `workpilot-board` sert cartes, spec, roadmap et idées aux apps d'IA ; serveur : `POST /mcp` avec jeton `wpat_` ou de tâche ; aucun outil ne build, n'approuve, ne fusionne ni ne prend de chemin. |
| Suivi de la PR | [pr-followup.md](architecture/pr-followup.md) | La carte fait avancer sa PR jusqu'au merge : check rouge ou fil de revue au QA fixer, commit vérifié (aucun test sauté, aucune CI modifiée), push jamais forcé ; une forge illisible n'est jamais du vert, un échec rouge aussi sur la base n'est pas « corrigé ». |
| App mobile (iOS, Android) | [mobile-app.md](architecture/mobile-app.md) | Client Expo du mode serveur : Kanban en direct (`GET /api/board/cards`, `project:<id>`), actions d'une carte ; refresh dans le Keychain ou le Keystore, un à la fois, HTTPS sauf réseau local ; APK et simulateur iOS en artefacts de `mobile.yml`. |
| Mode serveur | [server-mode.md](architecture/server-mode.md) | Une équipe sur un serveur : organisations, rôles, groupes, sans fuite entre tenants ; features partagées par `project_id` ; runs confinés à leur clone (Landlock). Exploitation : [server-operations.md](server-operations.md). |
| Collaboration d'équipe | [collaboration.md](architecture/collaboration.md) | Tableau serveur : salle du projet (`project:<id>`) avec présence sans e-mail, chat en base écrit par les membres, claims libérés par le serveur, modification de carte arbitrée (`reconcileEdit`), notifications gardées sur l'ordinateur. |
| Essai à blanc | [plan-rehearsal.md](architecture/plan-rehearsal.md) | Plan d'une spec rejoué sur sa base, sans écriture ni modèle. |
| Bac à sable de l'OS | [os-sandbox.md](architecture/os-sandbox.md) | Processus d'agent sous bubblewrap (Linux) ou Seatbelt (macOS) : écritures dans le worktree, identifiants masqués, réseau par un proxy filtrant (provider + registres) ; sans bac à sable la carte le dit au lancement, `WORKPILOT_SANDBOX=required` refuse de démarrer ; Windows pas encore. |
| Multi-dépôts | [multi-repo.md](architecture/multi-repo.md) | Analyse Python (graphe, ordre, ruptures), puis une carte Kanban par dépôt dans son projet, lancée quand la précédente a passé la QA, avec ce que les précédents ont changé ; une carte en attente suspend la suite ; reprise par le manifeste ; dépôts = projets enregistrés ou dossiers choisis. |
| Best-of-N | [best-of-n.md](architecture/best-of-n.md) | Une tâche construite N fois, une variante par moteur ; classement chiffré, choix humain, rien de fusionné. |
| Découpage auto | [task-split.md](architecture/task-split.md) | Plan > plafond de lignes : N cartes, dépendantes empilées (F6). |
| Variantes et rejeux | [variants-and-replays.md](architecture/variants-and-replays.md) | ADR : `best_of_n` seul mécanisme de variantes ; `replay` et `bench` séparés ; un fork de Time Travel est enregistré, jamais exécuté. |
| Mode objectif | [goal-mode.md](architecture/goal-mode.md) | Une commande dit « fini » : chemins protégés, plafond de passes et de dépense, fichier qu'aucun agent n'écrit. |
| Besoin de toi | [needs-you.md](architecture/needs-you.md) | Notifications lues dans XState ; ntfy, Telegram ; approbation d'un plan par jeton à usage unique. |
| Automatisations | [automations.md](architecture/automations.md) | Un événement (issue étiquetée, CI rouge, horaire, incident de prod lu sans port ouvert) crée une carte du Kanban, en brouillon par défaut, dédoublonnée, sous plafond du jour ; une PR ouverte par quelqu'un d'autre reçoit la revue de GitHub PRs, jamais publiée. |
| Bounty Board | [bounty-board.md](architecture/bounty-board.md) | Concours notés sur artefacts ; une preuve absente renormalise, ne vaut jamais zéro. |
| Délégation aux sous-agents | [delegation.md](architecture/delegation.md) | `native` (Claude), `emulated` (outil `delegate` + session enfant du même client sur la boucle WorkPilot), `none` (CLI) ; le scope d'un enfant ne s'élargit jamais. |
| Moteur d'agents comme port | [agent-runtime.md](architecture/agent-runtime.md) | `agent_runtime` : un Protocol que `core` installe à l'import ; merge, intégrations, analyse et architecture lancent leur session par lui au lieu d'importer `core` ou `agents` ; aucun client en plus, chaque appel va à la fabrique de `core`. |
| Types de tâche Kanban | [kanban-task-types.md](architecture/kanban-task-types.md) | Le type de tâche décidé sans token, un workflow YAML par type (`workflows/registry.py`, `fallback:`, `when:`), BMAD là où il est documentaire, RUN exécuté par Python derrière une pause avant l'irréversible ; à venir : rosters par type. |
| Workflows déclaratifs | [workflows.md](architecture/workflows.md) | `workflow.yaml`, élagage par effort, fenêtres, rosters, passage de phase ; le logger de workflow. |
| Revue guidée | [guided-review.md](architecture/guided-review.md) | Le diff regroupé par sous-tâche du plan (plages de `build_commits.json`), puis orphelins, puis non-commité ; explication du planner, aucun modèle ; « vu » invalidé par le hash du patch ; le renderer ne passe qu'un `taskId` ; local. |
| Guider une tâche en cours | [steering.md](architecture/steering.md) | `foundation/steering.py` : `steering.jsonl` en ajout seul dans chaque copie du dossier de spec ; le message entre dans le prompt de la prochaine session, marqué reçu par l'orchestrateur, jamais par le modèle ; fichier interdit aux agents. |
| Agent d'onboarding | [onboarding-agent.md](architecture/onboarding-agent.md) | Visite par rôle, points chauds (churn git, points de décision, zones sensibles, tests), décisions (ADR, commits cassants, Brain), quiz ; sans modèle sauf la narration ; régénérée quand les modules changent ; export échappé. |
| Commentaires de revue ancrés | [review-comments.md](architecture/review-comments.md) | Un commentaire sur une ligne du diff guidé, envoyé au fixer avec `chemin:ligne` ; `addressed` décidé par le diff de sa session ; seul l'humain résout. |
| Pointer un élément de l'aperçu | [preview-point.md](architecture/preview-point.md) | Sélecteur par le protocole DevTools, sans script injecté ; fichiers candidats par marqueurs (toutes stacks) ; l'élément part en guidage, cité comme donnée. |
| Pause et reprise | [pause-resume.md](architecture/pause-resume.md) | `foundation/pause_state.py`, `BuildPaused` / `BuildHalted`, reprendre une phase sans la payer deux fois. |
| Gestion du contexte | [context-management.md](architecture/context-management.md) | Artefacts sobres (un fait, un endroit) et politique compact / clear par tâche, native ou émulée. |
| Harness de contexte | [context-harness.md](architecture/context-harness.md) | Tous providers : mesure commune, budget et arrêt sans progrès, préfixe stable, troncature à la source, purge par lots, retours de sous-agents bornés, outils figés, `search_code`, rejeu à chaque PR. |
| Veille des contrats d'API | [api-contract-watcher.md](architecture/api-contract-watcher.md) | OpenAPI, GraphQL, protobuf comparés à la base de fusion, sans modèle ; consommateurs ; `x-breaking-acknowledged` ; porte QA `warn`/`strict`. |
| Mode hors-ligne | [offline-mode.md](architecture/offline-mode.md) | `airgapStrict` comme barrière, sinon comme défaut. |
| Budget carbone | [carbon-profiler.md](architecture/carbon-profiler.md) | CO₂ estimé de chaque appel (tokens, taille, PUE, réseau) ; budget du mois, alerte une fois par seuil, flagship → standard en mode dégradé ; export ESRS E1-6 / GRI. |
| Architecture frontend | [frontend-architecture.md](architecture/frontend-architecture.md) | Stores, activité de fond et barre latérale, agents, profils, terminaux, liens d'auth. |
| Panneau de tâche | [frontend-task-panel.md](architecture/frontend-task-panel.md) | Progression (`shared/progress.ts`), onglets Avancement / Qualité / Coûts et contexte, bannière « ce qui vous attend », critères d'acceptation, graphe des changements. |
| Moteur de tâche et LLM de page | [task-engine.md](architecture/task-engine.md) | Une tâche possède son provider × LLM × effort par phase ; une page résout le sien par `page-llm.ts`. |
| Visual-to-code | [visual-to-code.md](architecture/visual-to-code.md) | Documents d'architecture et leur historique sur disque. |
| Charte UI | [ui-charter.md](architecture/ui-charter.md) | `components/charter/` : scène, colonnes, cartes à rail, un seul bouton principal, pour tous les modules et Réglages. |
| Docs et dérive | [docs-and-drift.md](architecture/docs-and-drift.md) | Tous langages, sans modèle : doc comments, exemples, doc périmée (git) ; corrections en revue. |
| Revue et refactoring | [code-insights.md](architecture/code-insights.md) | IPC `codeInsights:run` ; smells et règles de revue pour toutes les piles. |
| Assistant vocal | [voice-assistant.md](architecture/voice-assistant.md) | Raccourci global (Ctrl+Shift+Espace, sans AltGr ni raccourci pris), Whisper local, commandes simples lues localement puis modèle « Assistant vocal » ; liste fermée d'actions (vue de la barre latérale, tâche après confirmation, réglages), réponse revalidée dans le main. |
| Émulateur d'app | [app-emulator.md](architecture/app-emulator.md) | Adresse d'arrivée déduite du diff, barre d'adresse, ouverture dans le navigateur. |
| Agent d'accessibilité | [accessibility-agent.md](architecture/accessibility-agent.md) | WCAG 2.2 lu dans le balisage de toutes les stacks et le CSS (liaisons, spread, composants : silence si incertain), contraste, score 0-100 et historique ; scan dynamique en fenêtre cachée sur localhost ; corrections sur carte de revue. |
| Mode Arena | [arena.md](architecture/arena.md) | De vrais concurrents (provider, modèle) et un coût mesuré. |
| Banc de rejeu | [repo-bench.md](architecture/repo-bench.md) | Cartes terminées rejouées par moteur depuis le commit d'avant, jugées par les tests du commit d'arrivée (F2P/P2P) ; recommande par type de carte le moteur le moins cher proche du meilleur, jamais appliqué seul ; une règle candidate est mesurée sans et avec elle. |
| Recette de worktree | [worktree-recipe.md](architecture/worktree-recipe.md) | Worktree de tâche préparé avant la première session : recette détectée selon la stack, ou `.workpilot/worktree.toml` approuvé par empreinte ; sans shell ; seuls les fichiers ignorés sont copiés ; ports par tâche ; une étape en échec arrive dans le prompt. |
| Code généré en revue | [generated-review.md](architecture/generated-review.md) | Le code d'une page va sur la branche d'une carte en revue, jamais dans le dossier du projet. |
| Outils de développement | [dev-tools.md](architecture/dev-tools.md) | MCP Electron pour l'E2E, Chrome DevTools MCP, grepai. |
| Dépannage | [troubleshooting.md](architecture/troubleshooting.md) | Problèmes courants et où regarder. |

Une nouvelle feature dont la conception mérite d'être expliquée : un fichier dans `architecture/` et
une ligne ici (`tests/test_docs_context.py` le vérifie).
