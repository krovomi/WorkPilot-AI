---
feature: Où tournent les longues suites d'une tâche
summary: >-
  Avant une revue QA complète, WorkPilot décide sans modèle où tourne la suite complète : ici,
  sur la CI de la forge ou sur le serveur WorkPilot, d'après le CPU, la RAM, le GPU et la VRAM
  libres et la charge mesurée de la suite du projet ; sans place ni route, une file d'attente
  par machine, jamais une suite sautée.
---

# Où tournent les longues suites d'une tâche

Une revue QA complète lance la suite complète du projet (non-régression, build, e2e). Sur une
machine qui fait déjà tourner d'autres tâches, cette suite fait ramer l'ordinateur de la
personne ; attendre qu'elle ouvre une PR pour la lancer sur la CI fait perdre des heures (dix
tâches finies pendant une absence, rouges une fois les PR ouvertes). Le paquet
`apps/backend/test_placement/` décide, juste avant la session du reviewer, où cette suite tourne.

## Le réglage

| Valeur | Qui la pose | Effet |
|---|---|---|
| `WORKPILOT_TEST_PLACEMENT` = `auto`, `machine` ou `ci` | la carte : `testPlacement` de `task_metadata.json`, sinon l'environnement du build | gagne sur le projet |
| `TEST_PLACEMENT` | le projet (`.workpilot/.env` ou l'environnement) | défaut du projet |
| `TEST_PLACEMENT_ALLOW_BRANCH_PUSH` | le projet ; l'app le pose quand le projet a une CI | `auto` peut pousser la branche sans PR |
| `WORKPILOT_TEST_PLACEMENT_ROUTES` = `ci`, `server` | l'app seulement, sur l'environnement | les routes hors machine que l'app suit après le build |

Une valeur hors liste vaut le défaut (`auto`) : une faute de frappe ne sort pas une suite de la
machine. `WORKPILOT_TEST_PLACEMENT_ROUTES` n'est jamais lu dans un fichier : une route que
personne ne suit serait une suite que personne ne lance, donc sans elle tout reste ici, y
compris une carte réglée sur `ci` (raison `not_followed`).

## La décision (`decide.py`, pure)

- `machine` ou `ci` choisis à la main : obéis, rien n'est mesuré pour `machine`.
- `auto`, aucun autre build sur la machine : ici (`alone`).
- `auto`, la machine a la place (`fits`) : ici (`room`). La place, c'est la demande de la suite
  plus un cœur, et un dixième de la mémoire (1 Gio au moins), laissés à la personne ; la VRAM
  n'est jugée que si la suite en a pris les dernières fois et qu'un GPU se lit.
- Sinon, dans l'ordre : la CI si la PR de la tâche existe (`pr`), le serveur WorkPilot s'il est
  connecté et suivi (`server`), la CI par une branche poussée sans PR si le projet l'autorise
  (`branch_push`), sinon la file (`queue`).

## Mesures (`machine.py`, `demand.py`)

La machine : psutil (cœurs logiques, charge sur une seconde, mémoire disponible) ; les GPU par
`nvidia-smi` s'il est sur le PATH, sinon aucun GPU, jamais une supposition ; les autres builds sont
les processus `run.py` de la même installation, le build courant et ses ancêtres exclus.

La demande : chaque session de revue complète lancée ici est mesurée (`Meter`) sur l'arbre de
processus du build, base d'avant la session retirée (le CLI de l'agent) : 90e centile des cœurs
utilisés (temps CPU entre deux relevés), pic de mémoire résidente, pic de VRAM des PID de l'arbre.
Une ligne par session dans `.workpilot/test-placement/history.json` du projet principal (partagé
par les worktrees de toutes ses tâches, 20 lignes) ; la demande est la médiane des 10 dernières,
2 cœurs et 2 Gio tant que rien n'est mesuré.

## La file (`queue.py`)

Un fichier par suite qui attend ou tourne ici, dans `~/.workpilot/suite-queue/` (toute la machine,
tous projets), nommé par l'heure d'arrivée. Une suite en attente part quand la machine a la place
ou quand c'est son tour : aucune autre suite ne tourne ici et aucun ticket plus ancien n'attend.
Un ticket dont le processus est mort est retiré par le lecteur suivant. La file avance donc
toujours, une suite après l'autre au pire ; la pause de la tâche est relue à chaque tour et libère
le ticket.

## Ce que voient le reviewer et l'app

`test_placement.json`, dans le dossier de la spec : cible, raison, ce qui manque (`cpu`, `ram`,
`vram`), les mesures, l'attente. Écrit aussi pendant l'attente (cible `queue`) pour que la carte le
montre. Quand la suite part ailleurs, le prompt du reviewer reçoit une section qui lui dit de ne pas
lancer la suite complète, le build ni l'e2e, de lancer quand même les tests des fichiers changés et
de ceux qui les importent (échec rapide avant tout push), et d'écrire `"full_suite": "deferred to
<cible>"` dans son sign-off. Une machine illisible ne retient jamais la QA : la revue tourne ici.

Une revue légère ou ciblée ne lance que ses quelques tests : elle n'est pas placée.

## Ce qui n'est pas encore fait

- L'app : pousser la branche sans PR, déclencher et suivre le pipeline de chaque forge
  (`ci-pipeline-providers.ts`), ne mettre la carte en revue humaine qu'une fois la suite verte ;
  l'interrupteur Automatique / Manuel du projet et de la carte, la raison sur la carte. Tant que
  l'app ne pose pas `WORKPILOT_TEST_PLACEMENT_ROUTES`, chaque suite reste sur la machine.
- La suite remise au serveur WorkPilot.
- L'échec rapide en deux temps (tests touchés puis suite complète) et la relance de la suite des
  cartes vertes quand leur base avance.
