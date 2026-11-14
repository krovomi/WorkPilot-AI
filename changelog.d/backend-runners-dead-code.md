---
section: 🧪 Filets de test
---

- **Couverture backend, lot B1a (runners)** :
  - 13 modules de `runners/github/` qu'aucun code n'importait sont supprimés : `audit`, `cleanup`, `confidence`, `errors`, `learning`, `lifecycle`, `onboarding`, `override`, `purge_strategy`, `storage_metrics`, `testing`, `trust` et `sanitize`, soit 6 600 lignes jamais exécutées.
  - La couverture mesure désormais aussi les runners lancés en sous-processus, comme le fait l'application (`.coveragerc`).
  - Le backend passe de 67,3 % à 69,9 % de couverture, et son plancher de 58 % à 69 %.
- **L'outil `cleanup_pr_worktrees.py` se lance à nouveau comme le dit son usage** : `python cleanup_pr_worktrees.py --list` échouait sur `No module named 'foundation'`, car le chemin du backend n'était ajouté qu'après le chargement du gestionnaire de worktrees.
