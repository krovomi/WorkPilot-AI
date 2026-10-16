# Plan — spécialiser WorkPilot par type de tâche Kanban

> Plan par lots, comme [context-harness.md](context-harness.md). Rien ici n'est livré ; chaque
> lot dit ce qu'il ajoute, ce qu'il réutilise, ce qu'il coûte en tokens et ce qu'il prouve.
> [`docs/CLAUDE.md`](../CLAUDE.md) reste l'autorité sur les règles.

## Le constat

WorkPilot sait construire une **feature** : un seul workflow, `workflows/feature-build/`, joué
pour toute carte du Kanban quels que soient son origine (saisie, issue GitHub/Jira/Azure,
roadmap, idéation) et son intention. Une correction de bug paie la phase `brainstorm`, un
PRD-light et un planner conçus pour une feature ; un incident de production attend la QA ;
une tâche d'exploitation (relancer un job, tourner une clé, diagnostiquer une alerte) n'a pas
de place : il n'y a pas de « RUN », seulement du « BUILD ».

Ce qui existe déjà et n'est pas branché :

| Pièce | Où | État |
|---|---|---|
| Catégorie de tâche (`feature`, `bug_fix`, `refactoring`, `security`, `performance`, `infrastructure`, `testing`…) | `apps/frontend/src/shared/types/task.ts` (`TaskCategory`), `task_metadata.json` | saisie dans l'UI, lue par `commit_message.py` et le validateur de spec ; **n'influence aucune phase** |
| Classifieur d'intention (`bug_fix`, `hotfix`, `investigation`, `spike`, `deployment`, `monitoring`…) | `apps/backend/intent/` | prompt et modèles écrits, CLI de feedback ; **importé nulle part** |
| Type d'item importé (`azureDevOpsType`, `jiraType` : Bug, Story, Task) | `TaskMetadata` | stocké, jamais interprété |
| Complexité (`simple` / `standard` / `complex`) | `spec/complexity.py` | adapte les phases de **spec** seulement ; le build ne la voit pas |
| Prompts d'incident (`incident_production_responder.md`, `incident_cicd_analyzer.md`, `incident_proactive_analyzer.md`) | `prompts/` | un runner chacun, hors Kanban |
| `self_healing/`, `flaky_test_detective/`, `verify/` | backend | boucles autonomes ou outils, sans phase de workflow qui les enchaîne sur une carte |
| BMAD v6.12 (50 skills) | `skills/bmad/`, gate `_bmad/scripts/resolve_customization.py` | retiré du pipeline, disponible à la palette quand le projet cible a son `_bmad/` |
| Moteur de workflow : `min_effort`, `when: touches(...)`, `roster`, `dispatch`, `gate`, `hard_gate`, lentilles conditionnelles | `workflows/engine.py`, `workflows/spec.py` | capable de porter plusieurs workflows ; **un seul est chargé**, en dur (`cli/build_commands.py:162`) |
| Sous-agents sur tout provider | `harness/*/delegation.py` (branche `feat/subagents-any-provider`) | prérequis : le plan ne doit rien supposer de Claude |

Le plan branche ces pièces. Il n'ajoute un module que là où rien n'existe.

## Les principes

1. **Un type de tâche = un workflow YAML**, pas un `if` dans le coder. Le moteur sait déjà
   élaguer, dégrader, conditionner ; la spécialisation est de la **donnée**
   (`workflows/<type>/workflow.yaml`), relue par `validate_impls` sur un clone frais.
2. **Classer avant de payer.** Le type est décidé par le moins cher qui sait répondre :
   la catégorie saisie ou importée (0 token) → les mots du titre (0 token,
   `intent/` en mode règles) → un appel `complexity_assessor`-like à `low` (quelques
   centaines de tokens) seulement en cas de doute. Le type est écrit dans
   `task_metadata.json` et affiché dans le modal avant le build ; l'utilisateur peut le changer.
3. **BMAD est une capacité, pas une phase par défaut.** Un skill BMAD n'entre dans un workflow
   que par `impl: bmad/<skill>` et sous `requires` ; il n'est choisi que là où sa valeur est
   documentaire (cadrage, PRD, rétro), jamais pour exécuter du code — WorkPilot le fait mieux
   et moins cher. Sans `_bmad/` dans le projet, la phase est **remplacée** par l'équivalent
   WorkPilot (`fallback:`), pas sautée en silence.
4. **Tout provider.** Une phase ne nomme jamais un outil du SDK Claude. Ce qu'elle demande
   (`dispatch`, `roster`, outils du type d'agent) est résolu par `create_agent_client`, et un
   provider sans sous-agents reçoit la version séquentielle. Les gates déterministes (tests,
   détecteurs, lint) tournent sans modèle, donc partout.
5. **Chaque token a un lecteur.** Un rapport de phase que personne ne lit en aval n'est pas
   produit (règle déjà appliquée par `workflows/handoff.py`). Un type de tâche court
   (hotfix, RUN) a un workflow court ; l'effort n'ajoute pas de phases, il approfondit celles
   qui existent.

## Les types

| Type | Reconnu par | Ce qu'on en attend | Ce qu'on ne paie plus |
|---|---|---|---|
| `feature` | défaut | le pipeline actuel | — |
| `bug_fix` | catégorie, `jiraType`/`azureDevOpsType` = Bug, mots-clés (fix, crash, régression, erreur, exception, ne fonctionne plus) | **reproduire** avant de corriger, un test rouge qui devient vert, une cause racine écrite, pas de refonte | brainstorm, PRD, `ui-design-system`, `architecture-map` ; planner remplacé par un plan de reproduction |
| `hotfix` | `bug_fix` + urgence (priorité `critical`, mots prod/urgent/incident, item importé en P1) | le correctif minimal, vérifié, prêt à merger ; tout le reste après | QA itérative (une passe), revue réduite à `correctness`+`security` ; `human` gate déplacée **avant** le merge, pas après le planning |
| `investigation` | mots-clés (pourquoi, comprendre, analyser, diagnostiquer, flaky, intermittent), `intent` ≥ 0.7 | un rapport : cause probable, preuves `file:line`, options ; **aucun code** | coding, QA, verify ; roster `research` |
| `run` (exploitation) | mots-clés (relancer, redémarrer, purger, tourner, migrer les données, exécuter, déployer, rotation), `intent` ∈ {deployment, monitoring, data_migration}, catégorie `infrastructure` | une **procédure exécutée** dans le worktree ou contre l'environnement déclaré, chaque étape journalisée avec sa sortie, et un arrêt avant toute étape irréversible | spec, planner, coding, QA ; un seul agent `operator` à outils déclarés (Bash sous allowlist, pas d'écriture de code) |
| `refactoring` | catégorie, mots-clés | comportement inchangé prouvé : mêmes tests avant/après, aucun test modifié | brainstorm, PRD ; `hard_gate: tests-unchanged` |
| `test` | catégorie `testing`, mots-clés (couvrir, tests pour) | des tests qui passent sur le code existant, et échouent si on casse la cible | planner léger, QA remplacée par mutation-check déterministe |
| `docs` | catégorie `documentation` | le document, relu contre le code | tout le reste ; roster `solo` |
| `spike` | mots-clés (POC, prototype, évaluer, comparer), `intent` = spike | une branche jetable et un verdict | QA, verify, merge |

Un type non reconnu est `feature`. Un type reconnu avec confiance < 0.6 est **proposé**, pas
imposé : le modal le montre, le build attend la confirmation si `gate: human` est actif.

## Lot 0 — le type de tâche comme donnée — **livré**

- `apps/backend/tasks/classify.py` (pur) : `classify(title, description, metadata) ->
  Classification(kind, confidence, source, reasons)`. Ordre : choix de l'utilisateur
  (`kindSource == "user"`, jamais écrasé) → `metadata.category` → type importé (`jiraType`,
  `azureDevOpsType`, labels reconnus) → mots du titre et de la description (FR + EN, accents
  ignorés) → `feature` à faible confiance. Un `bug_fix` avec urgence (priorité `urgent` /
  `critical`, mots *prod*, *incident*, *hotfix*…) est un `hotfix`. `intent/` n'avait pas de
  règles réutilisables (classifieur LLM seul) : les règles sont ici.
- `apps/backend/tasks/metadata.py` : `classify_spec` écrit `kind`, `kindConfidence`,
  `kindSource` dans `task_metadata.json` sans toucher au reste ; `spec/pipeline/orchestrator.py`
  l'appelle avant `complexity_assessment`. Aucun appel modèle ; l'appel `low` en cas de doute
  (`confidence < 0.6`) est laissé au lot 1, qui saura quoi en faire.
- Frontend : `TaskKind`, `TaskKindSource` et les champs sur `TaskMetadata`
  (`shared/types/task.ts`) ; `TaskKindBadge` (badge sur la carte Kanban, sélecteur dans le détail
  de tâche qui persiste `kindSource: "user"` via `task:update`) ; i18n `tasks:kind.*` en `en` et
  `fr`.
- Preuve : `tests/tasks/test_classify.py` (table titre → type, catégorie, import, urgence, choix
  utilisateur, fichier de métadonnées), `TaskKindBadge.test.tsx`.

Coût : 0 token.

## Lot 1 — un workflow par type, choisi par le moteur — **livré**

- `workflows/<nom>/workflow.yaml` pour `bug-fix`, `hotfix`, `investigation`, `run`,
  `refactoring`, `test`, `docs`, `spike` ; `feature-build` ne change pas. Chaque `impl` résout
  sur un clone frais (`tests/test_workflows_by_kind.py` le vérifie à tout effort, pour chaque
  provider de `providers.yaml`) ; cinq procédures nouvelles dans `skills/tooling/` :
  `reproduce`, `investigate`, `runbook`, `proofread`, `spike-verdict`, émises par
  `skills:build` et lues par tout provider.
- `apps/backend/workflows/registry.py` : `WORKFLOW_BY_KIND` (table fermée : un dossier
  `workflows/` que nul type ne nomme est un fichier que personne ne joue), `workflow_for(kind)`,
  `workflow_for_spec(spec_dir)` (lit `kind` dans `task_metadata.json`), défaut `feature-build`.
  `cli/build_commands._resolve_workflow_profile` et `workflows/api.py` l'appellent ; la carte
  et le build choisissent donc le même pipeline. Un YAML spécialisé illisible retombe sur le
  défaut, en le disant.
- `workflows/spec.py` : `fallback: <pack>/<skill>` et `irreversible: true` (données ; le
  runner les lira au lot 3). `engine.resolve_profile(..., inventory=)` **substitue** le
  `fallback` quand l'`impl` n'est pas installée et l'écrit sur `ResolvedPhase.substituted_from`
  — le profil imprimé et l'API (`substitutedFrom`, `substitutionReason`) le montrent ;
  `validate_impls` ne signale une phase que si ni l'une ni l'autre ne résout. Le runner refait
  la même décision à l'exécution contre le **projet cible** (`_locate_procedure` : skill absent
  ou `requires` non satisfait → fallback), et la sortie de phase nomme ce qui a réellement tourné.
- Un workflow sans `planning` ni `coding` (investigation, run) **ne lance pas la boucle du
  coder** (`_workflow_writes_code`) : les phases de skill sont le build, la carte passe en
  revue humaine avec le rapport (`_conclude_without_coder`), ou en erreur avec la raison si une
  phase n'a pas pu tourner. Un workflow sans `qa` (docs, spike) clôt le build après ses phases.
  Les fenêtres (`phases_between`) savent fermer sur une borne que le workflow ne déclare pas :
  `before: qa` sans QA va jusqu'au bout, `after: coding` sans coder est vide.
- Hard gate nouveau, déterministe : `tests-unchanged` (`workflows/hard_gates.py`, lu sur le diff
  réel : aucun fichier de test touché), sur `refactoring`. `repro-green` reste à faire : le
  test écrit par `reproduce` fait partie de la suite, donc `tests-pass` le lit déjà.
- Ce que ce lot dit ne pas faire encore : `run` **écrit** la procédure (`procedure`, `gate:
  human`, agent `analyzer` en lecture seule) et s'arrête — l'exécuteur déterministe, l'agent
  `operator` et la pause avant l'irréversible sont le lot 3 ; `hotfix` garde la QA en boucle
  (la passe unique n'est pas exprimable) ; les workflows qui écrivent du code gardent
  `planning`, parce que la boucle du coder planifie à son premier tour quoi qu'en dise le
  profil ; la classification `low` en cas de doute n'est pas branchée.
- Preuve : `tests/test_workflows_by_kind.py` (registre, résolution sur clone frais × effort ×
  provider, substitution dans le moteur et dans le runner, fenêtres sans bornes, gate
  `tests-unchanged`, API par type), les suites `test_workflow_*` inchangées.

Coût : aucun token nouveau sur `feature` ; un `bug_fix` paie `reproduce` (une session) et ne paie
plus brainstorm, design system, carte d'architecture ; `investigation` et `run` paient une session.

## Lot 2 — BMAD à la demande, par `impl` + `fallback`

BMAD apporte de la valeur **documentaire** : cadrer un besoin flou, produire un PRD ou une
architecture, animer une rétro. Il n'en apporte pas pour exécuter du code. Le lot le rend
appelable là, et là seulement.

- `feature-build` : `brainstorm` gagne `impl: bmad/bmad-brainstorming`, `fallback:
  tooling/brainstorm-approaches` ; `min_effort: high` inchangé. Une phase optionnelle
  `prd` (`impl: bmad/bmad-create-prd`, `fallback: workpilot/spec`, `min_effort: ultrathink`,
  `when: kind == feature and complexity == complex`) **avant** la spec WorkPilot, dont la
  sortie est handée au planner (`handoff.py`) — un PRD que personne ne lit est le défaut
  qu'on a déjà corrigé une fois.
- `investigation` : `impl: bmad/bmad-deep-recon`, `fallback: tooling/brainstorm-approaches`.
- `spike` : `impl: bmad/bmad-technical-research`, `fallback: tooling/brainstorm-approaches`.
- Nouveau workflow `retro` (déclenché à la main, pas par une carte) :
  `impl: bmad/bmad-retrospective` sur les N dernières cartes mergées, `fallback:
  workpilot/observe`.
- Mécanique : `workflows/runner.py` applique déjà `requires` contre le **projet cible** ;
  avec `fallback`, un `requires` non satisfait **substitue** et le profil l'écrit (« prd :
  bmad absent → workpilot/spec »). `skills:bootstrap --pack bmad` reste l'opt-in par projet.
- Le faux `_bmad/scripts/resolve_customization.py` du dépôt est remplacé par un mock qui
  **échoue** (`exit 2`) : les skills gardent leur plan B (`customize.toml`), la palette et le
  profil cessent d'annoncer BMAD là où il n'est pas installé, et `skills:build` continue
  d'émettre les 50 skills dans `.agents/skills/` grâce à `requires` satisfait côté build.
- Tout provider : les skills BMAD sont des `SKILL.md` lus par l'agent de la phase ; rien n'y
  est propre à Claude. Leurs scripts (`uv run …`) tournent via `run_command` sous allowlist —
  `uv` est à ajouter à `project/command_registry/` avec validateur (il exécute du code).
- Coût : un skill BMAD vaut 2 à 6 k tokens de prompt ; il n'est lu que dans sa phase, jamais
  dans le préfixe d'une autre. `min_effort` et `when` font qu'un bug à `medium` n'en charge
  aucun.

## Lot 3 — RUN sûr : irréversible, pause, journal

- `irreversible: true` sur une phase → le runner pose un `BuildPaused` **avant** de la
  lancer (`core/pause_state.py`, repris), avec la liste des étapes à jouer dans le feed ; la
  reprise est explicite dans l'UI. Jamais contournable par l'agent (il ne touche pas ses
  garde-fous, S3).
- `tooling/execute-runbook` est **déterministe** (`CUSTOM_EXECUTORS`, comme `verify`) : le
  modèle a produit la procédure au lot 1, Python l'exécute ; aucun token pendant l'exécution,
  et une étape qui échoue arrête le reste et laisse l'état écrit.
- Journal : `<spec_dir>/workflow/run.md` (étape, commande, code retour, sortie paginée via
  `harness.domain.paging`, secrets masqués par `core/log_redaction.py`).
- Environnement cible : déclaré dans `.workpilot/environments.toml` (nom, commandes de
  santé, variables **nommées**, jamais leurs valeurs — S1) ; sans déclaration, RUN ne
  tourne que dans le worktree.
- Preuve : un test qui démontre qu'une étape `irreversible` ne s'exécute pas sans reprise, et
  qu'une commande hors allowlist est refusée dans la procédure.

## Lot 4 — rosters et prompts par type

- `agents/subagents/phases.py` : rosters `bugfix` (`test-runner`, `regression-hunter`),
  `operator` (`test-runner` seulement : il sait lancer les commandes de santé),
  `investigate` = `research`. `PHASE_ALIASES` : `operator → operator`,
  `reproducer → verify`. Rien de nouveau dans `SPECS` sauf si une lentille le réclame.
- Prompts : `prompts/reproducer.md`, `prompts/operator.md`, `prompts/runbook_writer.md` ;
  les prompts d'incident existants (`incident_*.md`) deviennent les lentilles de
  `investigation` quand les mots-clés sont ceux d'un incident.
- Overlays de langage : `.NET` ajoute à `test-runner` `dotnet test --filter` pour
  `reproduce` ; rien d'autre.
- Preuve : `test_subagents_coverage` étendu aux nouveaux `agent_type`.

## Lot 5 — l'origine de la carte renseigne le type

- Issue GitHub/GitLab/Jira/Azure : labels `bug`, `incident`, `tech-debt`, `spike` et le
  type d'item → `classify` (0 token). Le corps de l'issue reste une **donnée** (S2) : il
  n'influence que le type, jamais une commande.
- Roadmap et idéation : `ideationType` → `refactoring`/`security`/`performance`.
- `batch_analysis` (issues groupées) hérite du type majoritaire ; mixte → `feature`.
- Preuve : tests par connecteur, sur les fixtures existantes (`tests/test_github_pr_*`).

## Lot 6 — mesurer

- `learning_loop/observe.py` : le type de tâche est une dimension des patterns ; le ledger
  par type (tokens, passes de QA, taux de merge) alimente `agent_coach` (« vos hotfix coûtent
  3× un bug_fix : la QA à une passe n'est pas respectée »).
- `tests/test_review_lenses.py` compte les sessions qui lisent le diff **par type** ; un
  `hotfix` au-delà de deux est un échec de test.
- Le profil résolu (modal) montre le type, le workflow choisi, les phases substituées par
  `fallback` et le provider effectif.

## Ordre et dépendances

```
lot 0 (type comme donnée)
  └─ lot 1 (workflows par type, registry, fallback)
       ├─ lot 2 (BMAD par impl + fallback)
       ├─ lot 3 (RUN sûr)        ── dépend de feat/subagents-any-provider pour `roster`
       ├─ lot 4 (rosters/prompts)    sur Copilot, OpenAI, Gemini… (sinon RUN est `solo`, ce
       └─ lot 5 (origine → type)     qui reste correct)
lot 6 (mesure) après n'importe lequel
```

Chaque lot est une PR vers `develop`, verte sur `validate_impls`, `test_docs_context`,
`test_agent_tool_declarations` et `test_workflow_engine`, sur les trois OS de la CI.
État : lots 0 et 1 livrés ; lots 2 à 6 à faire.

## Ce que le plan refuse

- Un `if kind == "bug"` dans `coder.py` ou `build_commands.py` : la spécialisation est dans
  les YAML, ou elle n'est pas.
- Une phase BMAD obligatoire, ou présente dans un profil sans `_bmad/` : `fallback` ou rien.
- Un type décidé par un appel modèle quand une catégorie ou un label le donnait déjà.
- Une étape RUN jouée par le modèle : il écrit la procédure, Python l'exécute.
- Un outil, un roster ou une phase qui n'existe que sur Claude.
