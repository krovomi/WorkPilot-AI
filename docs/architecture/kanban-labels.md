---
feature: Étiquettes et filtres rapides du Kanban
summary: >-
  Des étiquettes libres sur les tâches (dix au plus, trente caractères), posées depuis le menu de la
  carte, montrées sous son titre et filtrables ; et deux filtres rapides, « Bloquées » et « Modifiées
  cette semaine ». En local comme en mode serveur, où le serveur revérifie les étiquettes.
---

# Étiquettes et filtres rapides du Kanban

Demandé le 22 novembre 2026 (« les mêmes options que des Kanbans dans JIRA »), lot 7a de l'étude
« Kanban agile ». Équivalent des « Labels » et des « Quick filters » de Jira.

## Ce que la personne voit

- Menu d'une carte (« ⋮ » et clic droit) : « Étiquettes… » ouvre `kanban/labels/LabelsDialog.tsx`.
  On tape une étiquette (Entrée l'ajoute), on reprend une étiquette déjà utilisée sur le tableau,
  on en retire une avec sa croix, puis on enregistre. Un refus d'enregistrement reste dans la
  boîte, avec un toast.
- Sous le titre de la carte, ses étiquettes en petites puces (`kanban/labels/CardLabels.tsx`). Un
  clic sur une puce filtre le tableau par cette étiquette, sans ouvrir la carte.
- Panneau « Filtres » de la barre d'outils : « Filtres rapides » en tête (« Bloquées »,
  « Modifiées cette semaine »), puis, quand le tableau en a, « Étiquettes ». Une vue enregistrée
  garde les deux.

## Règles

- **Une seule définition** (`shared/utils/task-labels.ts`) : une étiquette est coupée de ses
  espaces de bord, ses espaces internes réduits à un, sans caractère de contrôle, de 1 à 30
  caractères ; une tâche en porte dix au plus, chacune une fois quelle que soit sa casse. Tout
  lecteur passe par `taskLabels`, qui jette ce qui n'en est pas une.
- **Données du tableau, pas du run** : elles vivent dans `metadata.labels`, à côté du sprint et du
  couloir. Un agent ne les lit ni ne les change ; on peut les changer pendant qu'il travaille.
- **Mode serveur** : la carte passe par `PATCH /api/board/cards/{id}/settings`
  (`main/server-card-settings.ts`, clé de liste `labels`). Le serveur revalide
  (`apps/backend/shared_board/settings.py`, type `Label` : longueur, caractères de contrôle, dix au
  plus) ; la route garde sa permission. Le renderer n'est pas cru.
- **Filtres** (`lib/kanban-filter.ts`) : `labels` garde les tâches qui portent au moins une des
  étiquettes choisies, sans tenir compte de la casse ; `quick` les veut toutes : `flagged` (le
  drapeau « Bloquée », `kanban-outcome-columns.md`) et `recent` (`updatedAt` des sept derniers jours). Les deux
  champs sont optionnels : un filtre ou une vue enregistrés avant eux se lisent sans contrainte.

## Tests

`shared/utils/__tests__/task-labels.test.ts`, `lib/kanban-filter.test.ts`,
`stores/__tests__/kanban-filter-store.test.ts`, `kanban/labels/LabelsDialog.test.tsx`,
`kanban/KanbanToolbar.test.tsx`, `kanban/TaskCardMenuItems.test.tsx`,
`__tests__/TaskCard.test.tsx`, `main/__tests__/server-card-abandon.test.ts`,
`tests/backend/test_shared_board_labels.py`.
