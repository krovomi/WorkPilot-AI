---
section: 🧪 Filets de test
---

- **Chaque route du mode serveur et sa permission, sur une vraie base** (lot I1 de la couverture
  à 100 %). Deux organisations, tous les rôles, un groupe et des dépôts git réels : une matrice
  vérifie la règle de chacune des routes servies (sans jeton, jeton falsifié, permission manquante,
  autre organisation, rôle de projet), et des parcours couvrent connexion, projets, specs et runs,
  administration, invitations et réglages personnels (`tests/server_routes/`).
