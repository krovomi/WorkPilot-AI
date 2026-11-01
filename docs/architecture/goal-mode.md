# Mode objectif (`goal`)

Une tâche était finie quand le relecteur QA écrivait `approved`. C'était l'avis
d'un modèle, et « les tests passent » se lisait dans un rapport qu'il avait
lui-même rédigé. Le mode objectif donne à la carte une définition de « fini »
qu'on peut exécuter : une commande et le code de sortie attendu
(`dotnet test` → 0). La boucle QA continue tant que la commande échoue, dans
un nombre de passes et un plafond de dépense, et l'approbation du relecteur ne
suffit plus.

```
apps/backend/goal/
  spec.py      l'objectif, lu dans <spec>/.workpilot-goal.json
  check.py     lance la commande, lit son code de sortie
  protect.py   ce que la tâche a modifié, comparé aux chemins protégés
  spend.py     ce que la tâche a dépensé, lu dans cost_data.json
  gate.py      l'ordre des vérifications, le verdict, la demande de correction
apps/backend/security/child_env.py        l'environnement sans identifiants
apps/backend/qa/loop.py                   la porte, après le relecteur et les autres portes
apps/backend/cli/build_commands.py        la même porte quand la QA est sautée
apps/frontend/src/main/ipc-handlers/task/goal-handlers.ts
apps/frontend/src/renderer/components/task-detail/GoalCard.tsx
```

## L'objectif

| Champ | Défaut | Bornes |
|---|---|---|
| `command` | (requis) | une ligne, 4 096 caractères |
| `expectedExit` | 0 | 0 à 255 |
| `timeoutSeconds` | 600 | 10 à 7 200 |
| `maxRounds` | le plafond de l'effort QA | 1 à 50 (`MAX_QA_ITERATIONS`) |
| `maxCostUsd` | aucun plafond | au-dessus de 0, 10 000 au plus |
| `protected` | aucun | 64 chemins relatifs au dépôt, sans `..` |

L'objectif vit dans `<spec>/.workpilot-goal.json` et **pas** dans
`task_metadata.json`. Un agent peut écrire les métadonnées, et un objectif
qu'il peut réécrire est un objectif qu'il atteint avec `true`. Le nom est dans
`PROTECTED_CONFIG_NAMES` (`security/path_guard.py`) : le hook d'écriture,
l'exécuteur hors SDK, le validateur Bash et le garde-fou pi le refusent à tous
les agents, comme la configuration de sécurité (S3). Le main l'écrit,
depuis la carte, dans chaque copie du dossier de spec. Pour une carte du
serveur, c'est l'API du serveur qui l'écrit (`PATCH /api/board/cards/{id}/settings`,
`shared_board/settings.py`), avec les mêmes règles : le miroir de l'app n'est
lu par aucun run. Le backend lit la copie du projet principal d'abord. Une seule autre écriture, en Python et jamais par
un agent : la phase `spec-by-example`, sur une tâche qui n'a pas d'objectif,
après avoir vérifié que les tests qu'elle a fait écrire compilent et échouent
([spec-by-example.md](spec-by-example.md)).

Un fichier présent mais illisible ne veut pas dire « pas d'objectif » : la QA
s'arrête avant la première passe (`invalid`), et une personne corrige
l'objectif.

## La porte, et l'ordre des vérifications

La porte tourne quand le relecteur a approuvé et que les portes
d'architecture et de couverture ont laissé passer. Chaque étape vient avant la
suivante parce qu'elle écarte un faux positif.

| # | Vérification | Si elle échoue | Pourquoi avant la suivante |
|---|---|---|---|
| 1 | le fichier d'objectif se lit | `invalid` : arrêt, une personne décide | un objectif mal écrit ne doit pas se désactiver tout seul |
| 2 | les chemins protégés n'ont pas bougé | `unmet` : le fixer reçoit la consigne de les restaurer | le moyen le moins cher de faire sortir `pytest` en 0 est de modifier les tests |
| 3 | l'ensemble des modifications se lit | `error` : arrêt | sans lui, rien ne prouve que les chemins protégés sont intacts |
| 4 | la commande sort avec le code attendu | `unmet` : demande de correction avec la fin de la sortie | seul un code de sortie dit « fini » |

Le plafond de dépense est lu **avant** chaque passe (`budget`) : une passe
commencée après le plafond serait payée avant que quoi que ce soit l'arrête.

- **Chemins protégés.** Le script que la commande lance (`./scripts/check.sh`)
  est protégé d'office : le réécrire, c'est réécrire la définition de
  « fini ».
  - L'ensemble des modifications compare le worktree à son point de départ :
    commits, index, fichiers modifiés et fichiers non suivis.
  - Les renommages comptent sous l'ancien et le nouveau nom.
  - Le point de départ est `merge-base` avec la branche de base de la tâche
    (`baseBranch`), sa version distante d'abord.
  - Sans branche de base, l'ordre est celui de `_detect_base_branch`.
- **La commande.**
  - Elle tourne sans shell (`foundation.platform.split_command`). Pour
    plusieurs étapes, on appelle un script du dépôt.
  - Elle a son propre groupe de processus, pour qu'un dépassement de délai
    arrête aussi les enfants.
  - Elle reçoit l'environnement du backend **sans ses identifiants**
    (`security/child_env.py`, la règle d'`envWithoutCredentials`).
- **Le verdict.**
  - Un dépassement de délai vaut `unmet` : un blocage peut venir du code.
  - Un programme introuvable vaut `error` : aucun correctif ne peut y
    répondre.
  - La sortie de la commande est du contenu produit par du code qu'un agent a
    écrit. Elle passe par `quote_untrusted` (S2) avant d'entrer dans la
    demande de correction.

## Les autres chemins vers « fini »

- **Approbation déjà enregistrée.** Si la QA avait approuvé avant qu'on
  ajoute l'objectif ou qu'on modifie le code, la boucle relance la commande.
  Elle ne prend le raccourci « déjà approuvé » que si l'objectif est atteint.
- **QA sautée.** Quand l'effort ou le workflow saute la QA,
  `_goal_allows_done` exécute la porte. Si l'objectif n'est pas atteint, la
  carte reçoit `QA_MAX_ITERATIONS` et non `QA_PASSED`.
- **Escalade humaine du relecteur.** Le verdict de l'objectif est enregistré,
  pour que la carte dise où il en est.

## Ce que voit la carte

- `goal_result.json` dans le dossier de spec contient le verdict complet :
  code de sortie, délai, fin de la sortie, chemins protégés touchés et
  dépense.
- `implementation_plan.json` porte un résumé (`goal`), lu par le Kanban sans
  requête par carte, comme `verification`.
- La carte « Objectif » est dans la section « Plan d'exécution ». Elle n'est
  pas modifiable pendant un run.

## Limites connues

- **La dépense est un plancher.** Un provider sans prix connu enregistre un
  coût nul à côté de vrais tokens. Le plafond arrête quand même la boucle
  quand le plancher l'atteint, et la carte dit que le montant est partiel.
- **Une commande, pas une ligne de shell.** `a && b` ne marche pas : on
  appelle un script du dépôt.
- **Une modification de l'objectif pendant un run** est lue à la passe
  suivante. La carte est verrouillée pendant le run pour éviter de changer la
  règle en cours de partie.

## Vérifier

```
pytest tests/goal -q
cd apps/frontend && pnpm test -- goal-handlers GoalCard TaskOverview
```
