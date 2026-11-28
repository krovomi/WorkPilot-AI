---
feature: Vue liste du Kanban et vues enregistrées
summary: >-
  Le tableau se montre en colonnes ou en liste (une ligne par carte : statut, priorité, sprint,
  sous-projet, points, modification), triée par une colonne ou dans l'ordre du tableau, coupée par
  les couloirs choisis. Une vue enregistrée garde filtres, tri, affichage, couloirs et tri de la liste.
---

# Vue liste du Kanban et vues enregistrées

Demandé le 22 novembre 2026 (« d'autres vues que la classique »), lot 5 de l'étude « Kanban
agile ». Équivalent de la vue « Liste » de Jira.

## Ce que la personne voit

- Une bascule **Tableau / Liste** dans la barre d'outils (`kanban/BoardLayoutToggle.tsx`).
- En liste (`kanban/BoardList.tsx`), une ligne par carte : titre (pastille du type, drapeau
  « Bloquée »), statut (la colonne où la carte est rangée), priorité, sprint, sous-projet, points,
  date de dernière modification. Une ligne ouvre la carte, comme sur le tableau.
- Un en-tête trie la liste : croissant, décroissant, puis retour à l'ordre du tableau
  (`nextListSort`). Une carte sans la valeur va en dernier dans les deux sens ; deux cartes égales
  gardent l'ordre du tableau (`sortRows`, `lib/kanban-list.ts`).
- Avec des couloirs (`kanban-swimlanes.md`), chaque couloir est une section de la liste, repliable
  comme sur le tableau (mêmes couloirs repliés).
- Les filtres et la recherche s'appliquent tels quels : la liste lit `tasksByStatus` du tableau,
  sans second calcul.

## Choix

- **Une préférence par personne, rangée avec les couloirs** (`stores/kanban-lanes-store.ts`,
  `layout` et `listSort`, localStorage par projet) : deux membres d'un projet du serveur ne se
  changent pas l'affichage l'un de l'autre. `readLanePreferences` relit tout ce que le stockage
  contient et retombe sur le tableau et l'ordre du tableau.
- **BoardLanes choisit** entre colonnes et liste : `KanbanBoard.tsx`, à son plafond de taille, ne
  reçoit qu'un attribut (`onOpenTask`) sur une ligne existante.
- **Pas de glisser-déposer dans la liste** : on y lit et on y trie ; on déplace sur le tableau.
- **Vues enregistrées** (`stores/kanban-filter-store.ts`) : une vue garde aussi `layout`,
  `grouping` et `listSort`. Une vue enregistrée avant ce lot n'a que filtres et tri ; l'appliquer
  ne change ni l'affichage ni les couloirs. Ce que la vue rapporte est relu comme le stockage
  (`useKanbanLanesStore.applyView`), car en mode serveur les vues reviennent du main, qui les
  garde telles quelles.
