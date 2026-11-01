---
section: 🧪 Filets de test
---

- **Deux organisations sur un vrai serveur, de bout en bout** (lot MT5) : le job `server-e2e` démarre le serveur comme `deploy/` contre PostgreSQL, crée deux organisations par l'API, fait travailler chacune (cartes, flux en direct, un run avec un agent factice confiné, un job) et vérifie que l'autre reçoit 404 partout, que son flux lui est refusé, et qu'un lecteur ne peut rien écrire.
