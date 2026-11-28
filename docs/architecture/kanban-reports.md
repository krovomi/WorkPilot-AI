---
feature: Rapports du Kanban
summary: >-
  Burndown du sprint en cours, vélocité des sprints terminés, flux cumulé, temps de cycle, débit
  par semaine et fins non abouties, calculés dans le renderer depuis l'historique des statuts et
  les sprints. Tout est mesuré après coup : aucun rapport n'estime une durée à venir.
---

# Rapports du Kanban

Demandé le 22 novembre 2026 (« les mêmes options que les Kanbans de Jira »), lot 6 de l'étude
« Kanban agile ». Le bouton « Rapports » de la barre d'outils ouvre une fenêtre à onglets
(`components/kanban/reports/BoardReports.tsx`) ; les calculs sont des fonctions pures de
`lib/kanban-reports.ts`.

## Les rapports

| Onglet | Ce qu'il montre | D'où |
|---|---|---|
| Burndown | points restants du sprint en cours, jour par jour, contre la ligne idéale | `metadata.sprintId`, points (`taskPoints`), dernière entrée « done » de l'historique, `sprint.committed` |
| Vélocité | points engagés et terminés des 8 derniers sprints terminés, moyenne des 3 derniers | `sprint.committed`, `sprint.report` (`kanban-sprints.md`) |
| Flux cumulé | tâches par étape (à faire, en cours, en revue, terminées) à la fin de chacun des 30 derniers jours | `task.statusHistory` rejoué jour par jour (`task-status-history.md`) |
| Temps de cycle | du premier passage en « En cours » à « Terminée », pour les tâches finies ces 90 jours : médiane, 85e centile, répartition | historique |
| Débit | tâches terminées par semaine (lundi à dimanche), 8 semaines | historique |
| Fins non abouties | tâches en « Échec » par raison de revue, en « Abandonnée » par résolution | `getBoardColumn`, `metadata.abandonedResolution` |

## Choix

- **Dans le renderer, sans route ni IPC** : les tâches et les sprints y sont déjà (store des
  tâches, `useSprintStore`), en local comme pour un projet du serveur, dont l'instantané porte
  l'historique des statuts. Rien ne sort de la machine.
- **Le projet entier, pas les filtres du tableau** : comme les rapports de Jira, un filtre ne
  change pas la vélocité de l'équipe.
- **Mesuré, jamais estimé** (règle « aucune estimation de durée ») : le temps de cycle dit combien
  de temps les tâches finies ont pris ; aucun rapport ne prédit une date de fin. Les points restent
  le score de l'estimation intelligente.
- **Les tâches d'avant l'historique** : une tâche terminée sans historique compte à sa dernière
  modification ; dans le flux cumulé, une tâche sans historique compte dans son statut actuel depuis
  sa création. Une tâche abandonnée quitte le flux le jour de son abandon.
- **Jours locaux** : un jour du rapport est un jour du fuseau de la personne (`dayKey`), comme les
  dates d'un sprint.
- **Graphiques en SVG** (`reports/ReportCharts.tsx`), sans bibliothèque de graphiques : couleurs
  des thèmes par classes de texte, et chaque graphique a sa table de chiffres pour les lecteurs
  d'écran (`FigureTable`).
