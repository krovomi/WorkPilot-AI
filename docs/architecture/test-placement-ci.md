---
feature: Suite d'une tâche sur la CI de la forge
summary: >-
  Quand le build a envoyé sa suite complète à la CI, l'app pousse la branche de la tâche sans PR,
  juge la suite sur tous les runs de ce commit (GitHub Actions, Azure Pipelines, GitLab CI,
  Bitbucket Pipelines, Jenkins), lance à la main les pipelines qui valident les PR si le push n'en
  a lancé aucun, et rend la route à la machine pour un jour si rien ne démarre.
---

# Suite d'une tâche sur la CI de la forge

Côté backend, `apps/backend/test_placement/` décide avant une revue QA complète où tourne la suite
complète, et l'écrit dans `test_placement.json` ([test-placement.md](test-placement.md)). Une
route hors de la machine n'est prise que si l'app la suit : ce fichier-ci est ce suivi.

## Ce que l'app dit au build (`suite-placement/build-env.ts`, `ci-route.ts`)

`agent-process.ts` ajoute à l'environnement de chaque build :

- `TEST_PLACEMENT`, le réglage du projet (`testPlacement` : `auto`, `machine`, `ci`) ; le choix
  d'une carte (`testPlacement` de ses métadonnées) est lu par le backend dans `task_metadata.json` ;
- `WORKPILOT_TEST_PLACEMENT_ROUTES=ci` seulement quand la boucle « Build rouge » a résolu un
  fournisseur de CI pour ce projet (`setCiFollowed`) et que la route n'est pas mise de côté ;
- `TEST_PLACEMENT_ALLOW_BRANCH_PUSH=true` avec elle, sauf si le projet a
  `testPlacementBranchPush: false` (choix de Leub : actif par défaut dès qu'il y a une CI).

## Après le build (`ci-suite-flow.ts`, `ci-suite.ts`)

À la sortie d'un build (code 0, pas en pause), `ciPipelineService.startCiSuite` :

1. ne fait rien si `test_placement.json` ne dit pas `ci`, si le sign-off QA n'est pas `approved`,
   ou si ce sign-off a déjà été poussé (`ciSuite.signoffAt`) : un redémarrage ne pousse pas deux fois ;
2. pousse la branche du worktree vers `origin` : seulement `workpilot/<spec>` (sans `..`, rien
   qui commence par `-`), jamais forcé, sans `--no-verify`, avec les identifiants git de la
   machine et l'environnement git isolé ;
3. écrit `ciSuite` dans le plan : `pending`, la branche, le commit, l'heure du push.

Un push refusé (ou sans `origin`) est noté `not_started` avec sa raison.

## Le suivi (`ci-pipeline-service.ts`)

Une tâche dont le plan a un `ciSuite` avec un commit est jugée sur **les runs de ce commit**
(`fetchCommitRun`, repliés par `foldRuns` : rouge si un run est rouge ou annulé, en cours tant
qu'un run tourne, vert quand tous le sont), plus sur le dernier run de la branche, qui pouvait
être un autre workflow. Un fournisseur sans cette lecture (Jenkins) prend le dernier run de la
branche mis en file après le push.

| Situation | Suite |
|---|---|
| vert | `passed` |
| rouge | `failed`, puis le chemin rouge habituel : `BUILD_FAILURE.md`, colonne « Build rouge », réparation ; le build de réparation approuvé pousse à nouveau |
| aucun run après 3 min | `triggerRun` une fois : GitHub, les workflows vus sur `pull_request` qui acceptent `workflow_dispatch` ; Azure, les définitions vues sur `pullRequest` ; GitLab et Bitbucket, le pipeline de la branche décrit par son propre fichier. Jamais un pipeline de déploiement. |
| aucun run après 20 min | `not_started` ; la route CI de ce projet est mise de côté 24 h, les suites suivantes restent sur la machine |

## Dans l'app (`renderer/components/suite-placement/`)

- **Projet** (réglages généraux) : un interrupteur Automatique / Manuel. Automatique (le défaut)
  laisse `test_placement` décider et propose « pousser la branche sans pull request »
  (`testPlacementBranchPush`, activé par défaut) ; Manuel propose « cette machine » ou « la CI de
  la forge » (`testPlacement`).
- **Carte** (création, modification) : « Réglage du projet » (rien d'écrit), Automatique, ou un
  choix manuel, écrit en `testPlacement` dans `task_metadata.json` ; `qa/suite_placement.py` le
  lit et il passe avant le projet.
- **Badge** (`SuitePlacementBadge`) : rien quand la suite a tourné ici comme d'habitude ; sinon
  « en file d'attente », « sur la CI / le serveur », puis le verdict de la CI sur le commit
  poussé (en cours, verte, rouge, non lancée). La raison de la décision est au survol.
- **Fusion** : tant que `ciSuite.state` vaut `pending`, le bouton de fusion est désactivé et un
  bandeau le dit, avec le lien du run (`isHeldBySuite`). Rouge, la carte part en « Build rouge » ;
  non lancée, la carte le dit et la fusion reste possible (la personne décide).

`project-store.ts` porte `ciSuite` (validé par `readCiSuite`) et `suitePlacement` (validé par le
schéma zod de `placement-file.ts`) sur chaque tâche ; un enregistrement mal formé est ignoré.

## Ce qui n'est pas encore fait

- La suite remise au serveur WorkPilot.
