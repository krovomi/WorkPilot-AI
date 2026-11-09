---
section: ✨ Nouveautés
---

- **Red team : un agent essaie de casser ce que la tâche a construit** (F186). Après l'approbation de la QA d'une tâche complexe, une session écrit des tests d'attaque (entrées malformées, cas limites, injection de prompt sur le code qui appelle un modèle, concurrence, anciens bugs) dans le framework de test du projet, toutes stacks, dans une copie jetable du worktree ; WorkPilot les lance lui-même. Une erreur non gérée qui s'échappe du code de la tâche renvoie au fixer ; une réponse différente est affichée dans l'onglet Qualité de la tâche sans bloquer ; un échec qui ne se reproduit pas est écarté. Les passes suivantes rejouent les mêmes attaques sans modèle, et « Attaquer » sur la carte en lance une neuve. `WORKPILOT_QA_RED_TEAM` règle quand elle tourne (#381).
