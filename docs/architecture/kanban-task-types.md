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

## Lot 0 — le type de tâche comme donnée

- `apps/backend/tasks/classify.py` (nouveau, pur) : `classify(title, description, metadata) ->
  TaskKind(kind, confidence, source)`. Ordre : `metadata.category` → type importé → règles de
  `intent/` (réutilisées, sans appel modèle) → `None`. Pas d'appel LLM ici.
- `spec/pipeline/orchestrator.py` : avant `complexity_assessment`, si `classify` rend
  `None` ou < 0.6, **un** appel sous `agent_type="complexity_assessor"` (déjà `solo`, déjà
  `low`) dont le prompt demande aussi le type. Sortie structurée, écrite dans
  `task_metadata.json` (`kind`, `kindConfidence`, `kindSource`).
- Frontend : `TaskKind` dans `shared/types/task.ts`, badge dans la carte et le modal,
  sélecteur pour le changer (i18n `en`+`fr`). L'endpoint `/api/workflow-profile/` prend le type
  en compte (lot 1).
- Preuve : `tests/tasks/test_classify.py` (table titre → type, 0 token), un test d'intégration
  qui vérifie que `task_metadata.json` porte le type après la spec.

Coût : 0 token dans 80 % des cas (catégorie ou mots-clés), un appel `low` sinon.

## Lot 1 — un workflow par type, choisi par le moteur

- `workflows/<kind>/workflow.yaml` pour `bug-fix`, `hotfix`, `investigation`, `run`,
  `refactoring`, `test`, `docs`, `spike`. `feature-build` ne change pas.
- `workflows/registry.py` (nouveau) : `workflow_for(kind) -> Path`, défaut `feature-build`.
  `cli/build_commands.py:162` et `workflows/api.py` l'appellent au lieu du chemin en dur.
- `workflows/spec.py` : deux champs. `fallback: <impl>` (l'implémentation jouée quand
  `impl` ne résout pas — c'est ce qui rend BMAD optionnel sans trou dans le profil) et
  `irreversible: true` sur une phase (lot 3).
- `tests/test_workflow_engine.py::TestImplementations` étendu à **chaque** workflow : chaque
  `impl` et chaque `fallback` résout sur un clone frais, à tout effort, pour chaque provider
  de `providers.yaml` (le profil est honnête partout).

Squelettes (les `impl` existent déjà, sauf mention) :

```yaml
# workflows/bug-fix/workflow.yaml
phases:
  - id: reproduce          # nouveau skill tooling/reproduce : écrire le test qui échoue,
    impl: tooling/reproduce   # ou la commande qui montre le bug ; rapport = preuve
    agent: coder
    roster: verify          # test-runner seulement
    dispatch: fresh-context
  - id: planning           # le planner, mais nourri du rapport `reproduce` (handoff)
    impl: workpilot/planner
    gate: human
    min_effort: medium      # à low/none : le coder part du rapport, sans plan
  - id: coding
    impl: tooling/tdd-cycle
    dispatch: subagent-per-task
  - id: review
    impl: tooling/review-lenses
    roster: solo
    lenses: [correctness, regression]   # `regression` : nouvelle lentille — le test de reproduce passe, aucun autre ne change de verdict
  - id: verify
    impl: tooling/verify
    hard_gate: tests-pass,repro-green   # nouveau hard gate : le test écrit en `reproduce` est vert
  - id: qa
    impl: workpilot/qa-loop
    min_effort: medium
  - id: observe
    impl: workpilot/observe
```

```yaml
# workflows/run/workflow.yaml  — RUN : exécuter, pas construire
phases:
  - id: procedure          # nouveau skill tooling/runbook : lire le runbook du projet
    impl: tooling/runbook     # (.workpilot/runbooks/*.md) ou le dériver de la demande ;
    agent: operator           # sortie = liste d'étapes, chacune : commande, effet attendu,
    roster: solo              # réversible oui/non
    dispatch: fresh-context
    gate: human              # l'utilisateur relit la procédure avant toute exécution
  - id: execute
    impl: tooling/execute-runbook   # déterministe : Python joue les étapes une à une,
    irreversible: true              # journalise chaque sortie, s'arrête avant une étape
                                    # marquée irréversible et redemande (pause coopérative)
  - id: confirm
    impl: tooling/verify     # l'état attendu est atteint (verify existe déjà)
    hard_gate: app-verified
  - id: record               # déterministe : la procédure jouée + sorties → .workpilot/runbooks/
    impl: workpilot/observe     # et la mémoire des builds (brain)
```

L'agent `operator` est une entrée `AGENT_CONFIGS` nouvelle : `Read`, `Grep`, `Glob`, `Bash`
sous allowlist, **pas** `Write`/`Edit` — on n'écrit pas de code en RUN. Les commandes
dangereuses passent par les validateurs de `project/command_registry/` ; une commande hors
allowlist est **refusée**, pas confirmée (règle S3).

`hotfix` = `bug-fix` sans `planning`, `qa` à une passe, `gate: human` sur une phase finale
`merge-ready` ; `investigation` = `brainstorm`-like en `research` + `report`, rien d'autre ;
`refactoring` = `feature-build` moins brainstorm/PRD, `hard_gate: tests-unchanged` (nouveau,
déterministe : le diff ne touche aucun fichier de test, la liste des tests collectés est la
même avant/après) ; `test`, `docs`, `spike` : deux ou trois phases chacun.

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

## Ce que le plan refuse

- Un `if kind == "bug"` dans `coder.py` ou `build_commands.py` : la spécialisation est dans
  les YAML, ou elle n'est pas.
- Une phase BMAD obligatoire, ou présente dans un profil sans `_bmad/` : `fallback` ou rien.
- Un type décidé par un appel modèle quand une catégorie ou un label le donnait déjà.
- Une étape RUN jouée par le modèle : il écrit la procédure, Python l'exécute.
- Un outil, un roster ou une phase qui n'existe que sur Claude.
