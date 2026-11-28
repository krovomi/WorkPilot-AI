---
section: 🧹 Maintenance
---

- **Les builds de release demandent un Node.js accepté par REA** : l'audit de l'app empaquetée refusait le Node 22 trop ancien du runner macOS ; `release.yml` demande désormais `^22.23.4`, la plage de `apps/backend/rea/pin.json`, et un test garde les deux d'accord.
