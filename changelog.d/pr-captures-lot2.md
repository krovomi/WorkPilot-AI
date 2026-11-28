---
section: ✨ Nouveautés
---

- **Les captures apparaissent dans la PR** : dès que la PR d'une tâche existe, sa description reçoit une section « Captures » avec l'avant et l'après de chaque écran, sur GitHub, GitLab, Azure DevOps et Bitbucket. Les images vont sur une branche à part du dépôt (`workpilot-captures`, jamais fusionnée) ou, sur Azure DevOps, en pièces jointes de la PR. Elles ne sont visibles que de qui voit le dépôt. La section est mise à jour quand les captures changent et retirée quand il n'y a plus rien à montrer. Les images d'une tâche sont gardées 30 jours après leur dernière mise à jour (`CAPTURES_RETENTION_DAYS`). Avec `CAPTURES_PUBLISH=review`, elles attendent qu'une personne les publie.
