---
section: 🐛 Corrections
---

- **L'application mobile d'un monorepo est retrouvée** : la détection n'explorait que le dernier dossier de chaque niveau, si bien qu'une app dans `apps/mobile/` passait inaperçue dès qu'un dossier comme `tests/` venait après `apps/`. Une carte serveur « Android seulement » construisait aussi toutes les plateformes : la cible choisie atteint maintenant le run du serveur.
