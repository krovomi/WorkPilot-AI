---
section: 🐛 Corrections
---

- **Suivi des dépenses sous Windows** : quand plusieurs tâches écrivaient en même temps dans le registre des dépenses d'un projet, une écriture pouvait passer sans verrou au moment où le précédent était relâché, et échouer (`Access is denied`). Elle attend maintenant son tour.
