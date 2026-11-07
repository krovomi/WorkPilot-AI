---
section: 🔒 Sécurité
---

- **Jetons de tâche en mode serveur.** Un jeton d'accès peut maintenant être limité à une carte :
  il n'atteint que le projet de la carte, ne modifie que cette carte, dure quelques heures et
  est révoqué dès que la carte est terminée. Les écritures faites par `/mcp` sont inscrites dans
  l'audit avec la tâche qui les a faites, pas seulement la personne.
