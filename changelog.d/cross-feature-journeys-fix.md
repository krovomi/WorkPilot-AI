---
section: 🐛 Corrections
---

- **La ligne CI/CD reste sous la PR d'une tâche** : après « Create Pull Request » depuis la revue,
  la fiche de la tâche perdait le pipeline que CI/CD Triggers venait de lancer (et la preuve
  visuelle) jusqu'au rechargement du tableau. Elle les garde désormais.
