---
section: 🛠️ Qualité
---

- **Toute PR verte vers `develop` est fusionnée seule** : le pilote de pile inscrit désormais d'office chaque PR non brouillon de ce dépôt vers `develop` (squash par défaut, dans l'ordre de sa pile), sans label ni auto-merge à poser. Celles de Dependabot comprises ; les PR vers `main`, les brouillons et les forks restent dehors, et le label `autopilot/off` retire une PR.
