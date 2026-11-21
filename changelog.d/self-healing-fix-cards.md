---
section: ✨ Nouveautés
---

- **L'auto-guérison corrige ses incidents par une carte du Kanban** : un échec de CI, une erreur de production ou un fichier fragile devient une carte du backlog (`Fix: …`, origine « Self-Healing »), avec l'analyse de l'incident. Son build planifie, code et passe la QA dans un worktree, puis attend votre revue avant sa PR. L'incident suit la colonne de sa carte (en correction, en QA, PR ouverte, résolu, échec), avec le lien de la PR.
  - La correction automatique de production suit enfin son propre réglage (désactivé par défaut) au lieu de celui de la CI/CD.
  - Le réglage « Créer automatiquement les PR » est retiré : la PR suit la revue de la carte.
  - Le taux de correction automatique compte les incidents dont la carte a atteint sa PR, et le temps moyen de résolution va du signalement à la résolution.
