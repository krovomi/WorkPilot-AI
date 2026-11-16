---
section: 🐛 Corrections
---

- **Worktree d'un terminal** : la branche de départ lue dans les réglages du projet ou dans son
  `.workpilot/.env` n'est retenue que si c'est un nom de branche valide, comme celle choisie dans
  la boîte de dialogue ; sinon le worktree part de la branche par défaut détectée.
