---
section: 🐛 Corrections
---

- **`pnpm dev` n'affiche plus « npm warn Unknown env config "manage-package-manager-versions" »**.
  pnpm passe ce réglage, qui n'existe que chez lui, à chaque script qu'il lance ; le lanceur du
  frontend démarrait ensuite npm, qui l'avertissait. Le npm du lanceur reçoit désormais un
  environnement sans ce réglage, et `dev:vite` et `build` n'appellent plus npm du tout.
