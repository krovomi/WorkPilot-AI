# Multi-dépôts : un changement, une carte par dépôt, lancées dans l'ordre

Un changement touche souvent plusieurs dépôts : une bibliothèque partagée et ses consommateurs,
une API et son front. La personne choisit les dépôts et décrit le changement une fois. WorkPilot
ordonne les dépôts (fournisseurs d'abord) et ouvre une **vraie carte Kanban par dépôt, dans le
projet de ce dépôt**. Chaque carte suit le pipeline de toutes les tâches (spec, plan, code, QA,
revue humaine, PR) dans son propre worktree. La carte suivante démarre quand la précédente a
passé la QA, avec ce que les dépôts précédents ont changé dans sa description.

Le module existait sans être branché : le bouton Démarrer émettait un événement que personne
n'écoutait, et l'orchestrateur Python n'écrivait que des specs (« for now, mark as ready »). Il
est branché ainsi plutôt qu'avec un pipeline à part, pour que chaque dépôt ait exactement ce
qu'a une tâche : moteur, sandbox, QA, revue, PR, reprise.

```
apps/backend/orchestration/
  orchestrator.py      analyze (graphe, ordre, spec maître), brief (description d'une carte), check (ruptures)
  repo_graph.py        graphe des dépendances, tri topologique, cycle refusé
  breaking_changes.py  ruptures d'exports, d'API, de types dans le diff d'un dépôt terminé
  cross_repo_spec.py   le manifeste, partagé avec le main
apps/backend/runners/multi_repo_runner.py         une sous-commande par étape, lignes [MULTI_REPO] {json}
apps/frontend/src/main/multi-repo/
  manifest.ts          lecture, écriture, création, dossier d'une orchestration
  engine.ts            le moteur des cartes (engine.json), revalidé à l'entrée
  run.ts               le déroulé (testé avec un hôte factice)
  task-outcome.ts      statut d'un dépôt lu dans sa carte
  host.ts              ce que le déroulé utilise de l'app : runner, projets, cartes, renderer
  service.ts           au plus un déroulé par orchestration
apps/frontend/src/main/ipc-handlers/multi-repo-handlers.ts
apps/frontend/src/renderer/components/multi-repo/  bouton « Multi-dépôts » de la barre du Kanban, dialogue
```

## Le déroulé

1. **Créer.** La personne choisit au moins deux dépôts (au plus huit) : des projets de cet
   ordinateur, ou des dossiers choisis dans la boîte de dialogue du système. Un dossier devient un
   projet (ajouté, initialisé), refusé s'il n'est pas un dépôt git avec un commit. Le manifeste
   est écrit dans `<projet>/.workpilot/multi-repo/<NNN-slug>/`, hors de `.workpilot/specs/` : un
   dossier de spec est une carte, une orchestration n'en est pas une.
   La personne choisit aussi le **moteur** des cartes (fournisseur × modèle × effort, par phase,
   le même `TaskEngineEditor` que la création d'une carte), amorcé comme une carte neuve : le
   fournisseur du projet hôte, sinon celui des Paramètres. Il est écrit dans `engine.json` à côté
   du manifeste et non dedans, parce que le runner Python réécrit le manifeste depuis sa
   dataclass à `analyze` et `check` et perdrait un champ qu'il ne connaît pas. Le main le
   revalide (fournisseur en minuscules, modèle borné sans caractère de contrôle, effort connu) ;
   un moteur mal formé est refusé, aucun moteur laisse chaque projet à son fournisseur par défaut.
2. **Analyser** (`analyze`). Lecture heuristique de chaque dépôt (`package.json`,
   `requirements.txt`, workspaces), graphe des dépendances, tri topologique. Un cycle arrête le
   déroulé avant toute carte. Une nouvelle analyse garde ce que chaque dépôt a déjà (projet, carte,
   worktree, statut) : c'est ce qui rend la reprise possible.
3. **Pour chaque dépôt, dans l'ordre.**
   - `brief` écrit la description de la carte : le changement, la part de ce dépôt, ses
     dépendances dans les deux sens, et pour chaque dépôt déjà terminé sa branche et
     `git diff --stat <base>...HEAD` de son worktree. Tous les dépôts terminés y figurent, pas
     seulement les fournisseurs détectés : un front qui appelle une API en HTTP ne partage aucun
     paquet avec elle.
   - La carte est créée par `createLocalTask` (le même code que `TASK_CREATE`), titrée
     `<dépôt>: <première ligne du changement>`, avec le moteur de l'orchestration en
     `buildEngineMetadata` (`engineLocked` : rien de global ne le remplace ensuite), puis lancée par `getTaskControl().start` (le
     bouton Démarrer du tableau).
   - Le déroulé suit la carte : par les statuts que `TaskStateManager` envoie au tableau
     (`addStatusListener`), et par une relecture du disque toutes les 15 s, au cas où un statut
     passerait par un autre chemin.
   - **Passée** : revue humaine sans rien à corriger, terminée ou PR créée. Le worktree, la
     branche, la base et l'URL de PR sont notés ; `check` cherche les ruptures que ce diff fait
     aux dépôts qui en dépendent et les ajoute au manifeste (sans doublon). La carte suivante les
     reçoit dans son brief.
   - **Vous attend** : plan à approuver, QA rejetée, erreurs, CI rouge. Le déroulé ne fait rien
     de plus, il dit sur quel dépôt il attend, et repart quand la carte bouge depuis le tableau.
4. **Fini** quand tous les dépôts ont passé la QA. Les PR restent celles de chaque carte.

## Arrêter, reprendre

Arrêter tue l'étape Python en cours, arrête la carte si ses agents tournent, et marque
l'orchestration `stopped`. Reprendre relance tout le déroulé : l'analyse, puis chaque dépôt.
Un dépôt passé est sauté, une carte déjà créée est réutilisée (relancée si elle n'a pas démarré
ou a été arrêtée), une carte supprimée arrête le déroulé en le disant. Une application fermée en
plein déroulé laisse un manifeste `executing` sans déroulé actif : le dialogue propose de reprendre.

## Ce qui reste vrai

- **Le renderer ne donne pas de chemin libre** (S6) : un dépôt est un projet enregistré (sa racine,
  pas un sous-dossier) ou un dossier choisi dans une boîte de dialogue de la session ; un id
  d'orchestration suit `^\d{3}-[a-z0-9-]+$` ; un projet serveur est refusé (ses cartes tournent sur
  le serveur). `tests/.../multi-repo-handlers.test.ts` envoie ce qu'enverrait un renderer
  compromis.
- **Le contenu des dépôts est une donnée** (S2) : le résumé de diff et les ruptures entrent dans la
  description d'une carte par `quote_untrusted(kind="diff")`. Une base de branche n'arrive à
  `git diff` que si c'est un nom de branche simple (ni option, ni `..`).
- **Un seul chemin vers les LLM** : les trois étapes Python n'en appellent aucun ; les agents sont
  ceux des cartes. Le runner est lancé avec `pythonRunnerEnv`, sans shell, et installe la
  redaction des logs.
- Le manifeste n'est jamais écrit par les deux côtés à la fois : le main attend chaque étape
  Python avant de relire le fichier.

## Limites

- La détection des dépendances est heuristique (paquets npm et pip, workspaces). Deux dépôts sans
  paquet commun sont lancés dans l'ordre choisi.
- Les dépôts passent l'un après l'autre, jamais en parallèle, même indépendants.
- Les ruptures sont cherchées par motifs de fichiers et lignes retirées : un indice pour l'agent
  suivant, pas une preuve.
