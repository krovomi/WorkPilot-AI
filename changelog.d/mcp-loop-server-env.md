---
section: 🐛 Corrections
---

- **Serveurs MCP de la boucle WorkPilot** : un serveur MCP lancé en commande reçoit la courte
  liste de variables par défaut du SDK MCP (PATH, dossier personnel, utilisateur, terminal),
  plus les variables de son entrée, comme les autres processus enfants de l'app.
