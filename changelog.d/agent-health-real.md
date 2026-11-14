---
section: 🐛 Corrections
---

- **Santé des agents lue dans les vraies tâches du projet** : le panneau notait un moniteur en
  mémoire que rien n'alimentait, et affichait toujours « aucune exécution ». Il lit maintenant le
  `task_logs.json` de chaque tâche Kanban du projet (la copie du worktree quand la tâche tourne,
  sans compter deux fois), et note chaque agent (planificateur, codeur, QA) par provider et
  modèle : taux de succès, erreurs, relances de phase, durée, tendance. Les couples qui n'ont pas
  encore trois phases terminées sont listés à part. Le bouton « Réinitialiser l'historique », qui
  vidait ce moniteur vide, est retiré.
