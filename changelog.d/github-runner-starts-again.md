---
section: 🐛 Corrections
---

- **La revue de PR, le tri et l'auto-correction des issues GitHub démarrent à nouveau** : `runners/github/runner.py` s'arrêtait dès son lancement sur `No module named 'services.io_utils'`. L'orchestrateur importe d'autres runners, qui remettent le backend en tête de `sys.path`, si bien que `services` désignait le paquet du backend. Le runner prend désormais `safe_print` dans `core.io_utils`. `check-auto-fix-labels` affiche aussi le numéro, le label et le titre de chaque issue au lieu du dictionnaire brut.
- **Tests du runner GitHub** : 28 tests au total.
  - 13 lancent le runner comme le fait l'application, contre un faux `gh` (`tests/gh_fake.py`, sous Windows, macOS et Linux).
  - 15 testent les commandes qui appellent un modèle, avec un orchestrateur de remplacement.
  - `runner.py` passe de 0 % à 99 % de couverture.
