---
feature: Frise du Kanban
summary: >-
  Troisième affichage du tableau : une barre par tâche, du début du travail à sa fin (ou à
  aujourd'hui tant qu'elle court), les semaines en tête et les dates des sprints en bandes, coupée
  par les couloirs choisis. Elle ne dessine que ce qui s'est passé : aucune date de fin estimée.
---

# Frise du Kanban

Demandé le 22 novembre 2026 (« d'autres vues que la classique »), fin du lot 6 de l'étude
« Kanban agile ». Équivalent de la « Timeline » de Jira, sans dates prévues.

## Ce que la personne voit

- La bascule d'affichage de la barre d'outils gagne « Frise » (`BoardLayoutToggle.tsx`), à côté de
  « Tableau » et « Liste » (`kanban-list-view.md`). Le choix est gardé par personne et par projet,
  et dans les vues enregistrées.
- Une ligne par tâche (`kanban/BoardTimeline.tsx`) : son titre, qui ouvre la tâche, et sa barre.
  La barre part du premier passage en « En cours » (ou de la création), et finit à « Terminée », à
  l'abandon, ou aujourd'hui pour une tâche qui court. Couleur : terminée, finie sans succès, en
  cours. Le nom accessible de la barre dit le statut et les dates.
- En tête : les lundis, et les sprints qui ont des dates (dates choisies, sinon démarrage et
  clôture), le sprint en cours mis en avant. Un trait marque aujourd'hui.
- Avec des couloirs, une section repliable par couloir, comme la liste.

## Choix

- **Rien d'estimé** (règle « aucune estimation de durée ») : une tâche ouverte s'arrête à
  aujourd'hui, jamais à une fin supposée. Les dates futures ne servent qu'aux sprints planifiés.
- **Fenêtre bornée** (`timelineWindow`, `lib/kanban-timeline.ts`) : de la plus ancienne barre,
  60 jours en arrière au plus et une semaine au moins, jusqu'à deux semaines après aujourd'hui.
  Une barre plus ancienne est coupée au bord.
- **Mêmes données que les rapports** : début et fin viennent de l'historique des statuts
  (`startTime`, `doneTime` de `lib/kanban-reports.ts`, `kanban-reports.md`).
- **Mêmes sections que la liste** : `BoardLanes` construit les sections une fois pour la liste et
  la frise ; `KanbanBoard.tsx` n'a pas changé.
