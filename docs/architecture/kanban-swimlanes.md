---
feature: Couloirs (swimlanes) du Kanban
summary: >-
  Le tableau se coupe en couloirs par priorité, type, sous-projet, origine ou tâche découpée ; chaque
  couloir tient toutes les colonnes. Glisser une carte dans un autre couloir écrit le champ
  (priorité, type, sous-projet), annulable par Ctrl+Z, en local comme en mode serveur. Les cartes
  « Bloquées » peuvent avoir leur couloir, en premier.
---

# Couloirs (swimlanes) du Kanban

Demandé le 22 novembre 2026 (« répartir le kanban par sprint, par sous-projets ou autres vues »),
lot 3 de l'étude « Kanban agile ». Jira, Linear, Azure Boards et GitHub Projects coupent tous le
tableau en lignes par un champ ; le sprint (lot 4) s'est ajouté à la liste.

## Le choix du regroupement

Le bouton « Couloirs » de la barre d'outils (`kanban/LaneGroupingMenu.tsx`) offre :

| Regroupement | Champ lu | Glisser d'un couloir à l'autre |
|---|---|---|
| Aucun | — | (le tableau d'avant) |
| Priorité | `metadata.priority` | écrit la priorité ; « Sans priorité » l'efface |
| Type | `resolveCardType` (les 14 types de carte) | écrit le type (`cardTypeChoiceMetadata`) ; « Pas encore de type » refuse |
| Sous-projet | `metadata.area` | écrit ou efface le sous-projet |
| Sprint | `metadata.sprintId` ([kanban-sprints.md](kanban-sprints.md)) | écrit le sprint s'il est en cours ou planifié ; « Backlog » l'efface ; un sprint terminé refuse |
| Origine | `getTaskSource` (manuelle, Jira, GitHub…) | refusé : l'origine ne se choisit pas |
| Tâche découpée | `splitGroupId` | refusé : le découpage décide |

Le choix est une préférence de la personne, par projet (`stores/kanban-lanes-store.ts`,
`localStorage`, relu par `readLanePreferences` qui écarte tout ce qui n'est pas valable), comme la
largeur des colonnes : deux membres d'un projet du serveur peuvent regarder le même tableau
autrement. Les couloirs repliés sont gardés par regroupement.

Les sous-projets viennent de trois endroits : les services de l'index du projet
(`getProjectContext`, un monorepo en a plusieurs), les valeurs déjà posées sur des cartes, et ceux
ajoutés à la main dans le menu (50 au plus), qui donnent un couloir vide où glisser des cartes. Un
nom de sous-projet tient sur une ligne de 80 caractères au plus (`cleanArea`).

## Le dessin (`kanban/BoardLanes.tsx`)

`KanbanBoard.tsx` (à son plafond de taille) passe ses colonnes à `BoardLanes` par `renderColumn` :
sans regroupement, la rangée d'avant ; avec, un couloir par valeur (`buildLanes`,
`lib/kanban-lanes.ts`), dans l'ordre du champ (priorité décroissante, ordre des types, ordre des
origines, alphabétique pour le reste), puis « Sans … ». Les priorités et les sous-projets connus
restent affichés vides : c'est là qu'on dépose une carte. Une colonne d'un couloir garde l'ordre
des cartes du tableau, sans sa ligne de résumé ni son état vide, et sa hauteur suit la colonne la
plus remplie du couloir.

Avec « Cartes bloquées dans un couloir à part » (activé par défaut), les cartes marquées
« Bloquée » (lot 1b, `metadata.flagged`) passent dans un couloir « Bloquées » en premier, comme le
couloir « Expedite » de Jira.

## Le glisser-déposer (`hooks/useLaneDrag.ts`)

dnd-kit veut des ids uniques : la colonne d'un couloir est une cible `lane::<colonne>::<couloir>`
(`laneDropId`), rendue par `SortableColumnWrapper` sans poignée de réordonnancement (on réordonne
les colonnes sans couloirs). `useLaneDrag` enveloppe `handleDragOver` / `handleDragEnd` du tableau :

1. il retient le couloir sous la carte (`useLaneOverStore`) : seule la colonne de ce couloir
   s'allume ;
2. au dépôt dans un autre couloir, il écrit d'abord le champ du couloir (`laneMetadata`) par
   `applyCardChoice` (`lib/card-edits.ts`), sur la carte ou toute la sélection qui la contient, et
   l'enregistre pour Ctrl+Z ;
3. il passe ensuite au tableau l'événement avec la colonne seule : le changement de colonne suit
   les règles habituelles (`useOutcomeDrop`, `canMoveTaskTo`, file d'attente…).

Un couloir dont le champ n'appartient pas au tableau refuse le dépôt (toast) et le tableau termine
le glisser comme annulé. Déposer dans « Bloquées » ouvre le dialogue du drapeau
(`FlagRequestDialog`, les tâches terminées en sont exclues) ; sortir une carte de « Bloquées » lève
son drapeau, puis écrit le champ du couloir d'arrivée s'il n'est pas le sien.

## Mode serveur

Les champs passent par le même chemin que la modification rapide : `updateTask`, puis pour une
carte du serveur `PATCH /api/board/cards/{id}/settings` (`main/server-card-settings.ts`).
`area` y est un `PLAIN_KEYS` de `shared_board/settings.py`, revalidé (une ligne sans caractère de
contrôle, 80 caractères au plus) ; comme les autres réglages, pas pendant un run (409, la carte
reste dans son couloir et un toast le dit).
