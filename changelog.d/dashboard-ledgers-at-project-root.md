---
section: 🐛 Corrections
---

- **Le tableau de bord et la page Coûts montrent enfin les tâches faites.** Une tâche Kanban écrivait ses tokens, son coût, ses verdicts QA et sa durée dans le `.workpilot` de son worktree, que ces vues ne lisaient pas et que la fusion supprime : un projet aux tâches terminées affichait 0 tâche, 0 token, 0 €. Toutes les sessions écrivent désormais à la racine du projet (verrou entre processus pour les tâches parallèles), les relevés des worktrees encore présents sont repris, les tâches sont comptées depuis le Kanban, la phase de spec compte ses tokens, le temps moyen par complexité se remplit, et un provider qui ne donne pas de prix est chiffré au catalogue. Local et mode serveur.
