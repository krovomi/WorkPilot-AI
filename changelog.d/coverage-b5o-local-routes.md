---
section: 🧹 Maintenance
---

- **API locale** : les routes HTTP que plus rien n'appelait sont retirées. Le tableau de bord
  (`/api/dashboard/snapshot`, `/stats`, `/export`) est construit par l'application depuis les
  relevés du projet. Refactoring, documentation et revue de code passent par leurs runners
  (`code_insights_runner`, `documentation_runner`). Les modèles de tâches et les statistiques de
  feedback n'avaient aucune vue. L'historique des sessions et les panneaux hermes et ui-ux-pro-max
  sont couverts à 100 %. Le lien d'une décision hermes vers sa tâche lit le chemin donné comme
  un nom, sans le résoudre.
