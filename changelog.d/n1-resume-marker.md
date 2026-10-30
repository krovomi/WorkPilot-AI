---
section: 🧹 Maintenance
---

- **Le marqueur `RESUME_WITH_PROVIDER` n'est plus lu** (F25 de l'audit). Plus rien ne
  l'écrit depuis #290 : reprendre une tâche avec un autre provider verrouille le moteur
  de la tâche dans `task_metadata.json`. La lecture gardée une version pour les tâches
  mises en pause sous 1.2.1 est retirée, et la résolution du provider n'a plus d'effet
  de bord.
