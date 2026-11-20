---
section: 🐛 Corrections
---

- **Erreur d'une sous-tâche du swarm identique sur chaque OS** : la fin de la sortie d'erreur
  d'une sous-tâche qui échoue se lit avec des fins de ligne `\n`, Windows compris, au lieu de
  garder des `\r\n`.
- **Swarm : une sous-tâche annulée dit qu'elle a été arrêtée** : annulée seule puis avec toute
  la vague, elle n'est plus tuée deux fois, ce qui faisait lire sur macOS un code de sortie 255
  au lieu de l'arrêt.
