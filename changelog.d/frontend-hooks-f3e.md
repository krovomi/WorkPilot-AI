---
section: 🧪 Filets de test
---

- **Couverture frontend, lot F3e (hooks)** : devise, combattants de l'arena, matrice des capacités des providers, statistiques de PR, raccourcis clavier et réglages du projet.
- **Coûts en euros** : un seul service de change sert tout l'écran ; les pages ouvertes ensemble ne le lisent plus qu'une fois, et l'anglais ne le lit plus du tout. La CSP du renderer perd l'hôte `api.frankfurter.dev`, qui ne servait plus à rien (resserrement).
- **Arena** : un provider sans adaptateur propre (LM Studio, par exemple) est reconnu quelle que soit l'orthographe de son nom et n'entre plus dans l'arena.
- **Statistiques de PR** : passer d'une PR à l'autre n'affiche plus les chiffres de la précédente, et le chargement s'arrête quand la PR disparaît.
- **Réglages du projet** : changer de projet pendant le chargement n'enregistre plus la configuration d'un autre projet, et l'état d'une connexion (GitHub, GitLab, Linear, Azure DevOps) se vide quand on désactive l'intégration au lieu de garder l'ancien.
