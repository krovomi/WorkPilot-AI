---
section: ✨ Nouveautés
---

- **La suite complète d'une tâche peut tourner sur la CI de la forge, sans PR.** Quand le build l'y
  envoie, l'app pousse la branche de la tâche, juge la suite sur tous les runs de ce commit
  (GitHub Actions, Azure Pipelines, GitLab CI, Bitbucket Pipelines, Jenkins), lance elle-même les
  pipelines qui valident les PR si le push n'en a déclenché aucun, et une suite rouge suit le
  chemin « Build rouge » jusqu'à sa réparation.
