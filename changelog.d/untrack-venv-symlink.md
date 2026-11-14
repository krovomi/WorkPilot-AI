---
section: 🐛 Corrections
---

- **Installation du backend rétablie sur un clone neuf** : un lien symbolique `apps/backend/.venv` vers un dossier d'une machine de développement était entré dans le dépôt ; sur tout autre poste c'était un lien mort à l'endroit où `pnpm run install:all` crée l'environnement Python. Il est retiré, `.venv` est ignoré même sous forme de lien, et un test refuse tout lien suivi qui sort du dépôt.
