---
section: 🐛 Corrections
---

- **Erreur d'une sous-tâche du swarm identique sur chaque OS** : la fin de la sortie d'erreur
  d'une sous-tâche qui échoue se lit avec des fins de ligne `\n`, Windows compris, au lieu de
  garder des `\r\n`.
