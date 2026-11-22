---
feature: Historique des statuts d'une tâche
summary: >-
  Chaque changement de statut d'une carte est ajouté à `<spec>/status_history.json` (de, vers,
  raison, date, acteur agent/personne/app, compte en mode serveur) : un seul écrivain par mode
  (processus principal en local, serveur sinon), un seul fichier par carte, borné, sans nom ni texte,
  envoyé dans l'instantané du tableau ; base des rapports (temps de cycle, flux, burndown).
---

# Historique des statuts d'une tâche

Lot 2 du Kanban agile (étude du 22 novembre 2026, [`kanban-columns.md`](kanban-columns.md) pour
les colonnes). Le tableau ne gardait que le statut actuel d'une carte : impossible de dire combien
de temps elle est restée « En cours », quand elle est arrivée en revue, ni combien de fois elle en
est repartie. Sans cela, ni temps de cycle, ni diagramme de flux cumulé, ni burndown (lot 6).

## Le fichier

`.workpilot/specs/<carte>/status_history.json`, à côté du plan :

```json
{
  "version": 1,
  "entries": [
    { "from": null, "to": "backlog", "at": "2026-11-22T10:00:00.000Z", "actor": "user" },
    { "from": "backlog", "to": "in_progress", "at": "…", "actor": "agent", "accountId": "u-1" },
    { "from": "in_progress", "to": "human_review", "reason": "completed", "at": "…", "actor": "agent" }
  ]
}
```

- `from` vaut `null` à la création, ou quand l'historique commence en cours de route (carte créée
  avant cette version : la première entrée part du statut que le plan avait).
- `reason` est la raison de revue (`completed`, `errors`, `plan_review`…) : rester en
  « Revue humaine » mais passer de `completed` à `errors` est un changement.
- `actor` : `agent` (les événements du build), `user` (une action sur le tableau), `system` (un
  observateur de l'app : PR fusionnée, CI rouge réparée, QA relancée sur une nouvelle base).
- `accountId`, mode serveur seulement : le compte qui a agi, ou qui a lancé le run dont l'agent a
  agi. Un identifiant opaque, jamais un nom ni une adresse.
- Le même statut avec la même raison n'est pas un changement : le gestionnaire d'état réécrit le
  statut restauré à chaque démarrage, cela ne doit pas ressembler à un mouvement.
- Borné à 300 entrées : la première (la création, d'où part le délai de livraison) et les plus
  récentes.

## Qui écrit

Un seul écrivain par mode, et toujours la copie de la carte dans le projet, jamais celle du
worktree : un historique par carte, qui survit à la suppression du worktree.

| Mode | Écrivain | Où |
|---|---|---|
| Local | le processus principal, là où il écrit le statut dans le plan | `apps/frontend/src/main/task-status-history.ts`, appelé par `persistPlanStatus` / `persistPlanStatusAndReasonSync` (`plan-file-utils.ts`) quand l'appelant nomme l'acteur ; création : `create-local-task.ts`, duplication : `crud-handlers.ts` |
| Serveur | le serveur | `apps/backend/server/services/status_history.py` : `follow_status` regarde la carte pendant un run (toutes les 2 s, plus un dernier regard à la fin), `record_status_change` pour la création (`shared_board/api.py`) et le renvoi en correction (`shared_board/review.py`) |

En local, l'acteur vient du gestionnaire d'état (`task-state-manager.ts`) : un événement du build
est l'agent, `handleUiEvent` / `handleManualStatusChange` une personne, sauf quand l'appelant est
un observateur et le dit (`"system"`). Le backend Python n'écrit pas l'historique en local : il
écrit le plan du worktree, et le processus principal relaie déjà chaque transition.

En mode serveur, il n'y a pas de processus principal : le run écrit le plan (celui du worktree
pendant un build), et le serveur lit la copie que le tableau montre (`shared_board/listing.card_source`),
sans suivre un lien qui sortirait du clone.

## Lecture

`Task.statusHistory` (`shared/types/task.ts`), lu par `project-store.ts` pour une carte locale
comme pour le miroir d'un projet serveur : l'instantané (`GET /api/board/snapshot`) envoie
`status_history.json` (100 Ko au plus, `SNAPSHOT_FILES` des deux côtés). Chaque entrée est
revérifiée à la lecture (statut, raison, acteur et compte en listes fermées, date lisible) ; une
entrée abîmée est ignorée, les autres gardées.

## Données personnelles (RGPD)

Minimisation : en local, aucune identité ; en mode serveur, l'identifiant de compte que le tableau
montre déjà comme auteur ou preneur d'une carte. Aucun texte libre. Conservation : l'historique
vit et disparaît avec la carte.

## Ce qui n'en dépend pas

Écrire l'historique n'échoue jamais un changement de statut : un fichier impossible à écrire est
un trou dans un rapport, pas une carte bloquée. Les rapports eux-mêmes (lot 6) et les colonnes
« Échec » / « Abandonnée » (lot 1) le lisent ; ils ne l'écrivent pas.
