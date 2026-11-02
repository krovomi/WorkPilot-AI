---
section: 🐛 Corrections
---

- **La vérification d'une app Windows ne renonce plus au premier démarrage.** Le module UI
  Automation compilait son code C# à chaque lancement, ce qui prenait 40 à 60 s sur une machine
  froide et dépassait parfois la minute accordée (« the UI Automation helper did not start »). Il
  est maintenant compilé une fois puis réutilisé, et la première compilation dispose de son propre
  délai.
