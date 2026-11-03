---
section: 🧹 Maintenance
---

- **`pnpm dev` ne montre plus l'avertissement `MODULE_TYPELESS_PACKAGE_JSON` au démarrage du backend.** Le lanceur `apps/backend/dev-server.js`, écrit en modules ES, s'appelle désormais `dev-server.mjs` : Node le charge directement en ESM au lieu de le relire une seconde fois.
