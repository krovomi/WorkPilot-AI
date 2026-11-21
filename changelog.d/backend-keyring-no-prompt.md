---
section: 🐛 Corrections
---

- **Le backend ne reste plus bloqué sur un trousseau Linux verrouillé.** En cherchant le jeton
  Claude, il demandait de déverrouiller le trousseau et attendait la réponse sans limite : sous WSL
  la fenêtre s'affichait vide et `/health` ne répondait plus. Un trousseau verrouillé est maintenant
  passé, et le jeton est lu dans `~/.claude/.credentials.json`.
