---
section: 🐛 Corrections
---

- **Supprimer un projet du serveur arrête d'abord ses agents et ses analyses** (F175). Ils ne
  continuent plus dans un dossier effacé, et sur un serveur SQLite les tâches, runs et membres du
  projet partent avec lui au lieu de rester orphelins.
