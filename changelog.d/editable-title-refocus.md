---
section: 🐛 Corrections
---

- **Titre de tâche modifiable : un enregistrement refusé rend vraiment le focus** : le champ était encore désactivé quand on y remettait le focus, si bien qu'il restait sans focus. Pire, le blur que le navigateur envoie au champ désactivé pouvait relancer en silence l'enregistrement du même titre. Le champ est désormais réactivé avant de recevoir le focus. Cela corrige aussi le test `EditableTaskTitle` qui échouait au hasard sur develop.
