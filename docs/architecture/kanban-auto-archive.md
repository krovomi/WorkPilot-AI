---
feature: Archivage auto et « Mes tâches » du Kanban
summary: >-
  Les tâches terminées depuis plus de 7, 14 ou 30 jours sont archivées d'elles-mêmes (réglage, éteint
  par défaut, projets locaux), comme le bouton « Archiver » ; et, sur un tableau du serveur, le filtre
  rapide « Mes tâches » ne garde que les cartes que mon travail tient (le claim du serveur).
---

# Archivage auto et « Mes tâches » du Kanban

Demandé le 22 novembre 2026 (« les mêmes options que des Kanbans dans JIRA »), lot 7b de l'étude
« Kanban agile ». Jira cache les tâches finies depuis deux semaines et propose « Only my issues ».

## Archivage auto

- Réglage « Archiver les tâches terminées » (Paramètres, Affichage, `kanbanAutoArchiveDays`) :
  Jamais (par défaut), après 7, 14 ou 30 jours. Toute autre valeur lue vaut « Jamais »
  (`autoArchiveDays`, `shared/utils/task-auto-archive.ts`).
- Le main (`main/kanban-auto-archive.ts`, lancé avec le suivi des PR fusionnées) regarde deux
  minutes après le démarrage puis toutes les heures. Il archive par `projectStore.archiveTasks`,
  exactement ce que fait le bouton « Archiver », puis recharge le tableau. Rien n'est supprimé :
  « Afficher les archivées » de la colonne Terminée les montre, et on les désarchive comme avant.
- « Terminée depuis » : le dernier passage à « Terminée » de l'historique des statuts
  (`task-status-history.md`), sinon la dernière modification de la carte.
- Projets locaux seulement : une carte du serveur appartient au serveur, l'app ne l'archive pas.

## « Mes tâches » (mode serveur)

- L'assigné d'une carte du serveur est celui dont le travail la tient (le claim, `SpecIndex.claimed_by`,
  que la salle d'équipe envoie comme verrous à `stores/collaboration-store.ts`) ; le badge
  `TaskLockBadge` le montre déjà sur la carte. Aucun champ « assigné » de plus : le serveur reste
  seul à décider qui tient une carte.
- Le filtre rapide `mine` (`lib/kanban-filter.ts`) ne garde que les cartes dont le verrou est à
  moi. Il n'est proposé que sur un tableau du serveur, une fois que la salle d'équipe a dit qui je
  suis. `useBoardFilters` (`stores/kanban-filter-store.ts`) ajoute ces cartes aux filtres, en
  gardant le même objet tant que rien ne change : `KanbanBoard.tsx` n'a changé que d'un appel.

## Tests

`shared/utils/__tests__/task-auto-archive.test.ts`, `main/__tests__/kanban-auto-archive.test.ts`,
`settings/DisplaySettings.test.tsx`, `lib/kanban-filter.test.ts`,
`stores/__tests__/kanban-filter-store.test.ts`, `kanban/KanbanToolbar.test.tsx`.
