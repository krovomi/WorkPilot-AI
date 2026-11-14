---
section: 🛠️ Qualité
---

- **La build du renderer n'avertit plus que `node:fs` et `node:path` sont « externalisés »**.
  `settings/multiconnector/utils.ts` gardait une fonction jamais appelée qui écrivait un fichier
  avec `fs`, ce qui ne peut pas marcher dans la page sandboxée ; elle est retirée, et un test
  refuse désormais tout import d'un module natif de Node dans le renderer.
