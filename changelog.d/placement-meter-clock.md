---
section: 🐛 Corrections
---

- **Une courte suite de tests compte aussi dans l'historique de placement sous Windows.** La durée
  mesurée d'une session se lit désormais sur l'horloge haute résolution : avec l'horloge
  monotone de Python 3.12, qui n'avance que toutes les ~15 ms sous Windows, une session courte
  durait 0 s et n'était jamais enregistrée.
