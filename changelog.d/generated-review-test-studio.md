---
section: 🐛 Corrections
---

- **Les tests générés arrivent sur une branche de revue, plus dans votre dossier de projet**
  (F180). Le studio de tests écrivait ses fichiers, et les paquets ajoutés aux manifestes,
  directement dans le projet, donc sur la branche courante. Chaque génération (Unitaire, E2E,
  TDD) et chaque ajout de paquets vont maintenant dans le worktree d'une carte « Code généré »
  en Revue humaine, comme une tâche du Kanban : vous relisez le diff, puis « Créer la PR ». Les
  générations suivantes rejoignent la même carte jusqu'à l'ouverture de sa PR.
