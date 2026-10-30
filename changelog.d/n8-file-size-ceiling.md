---
section: 🛠️ Qualité
---

- **Un gros fichier source ne peut plus grossir** (F130). Les 21 fichiers de plus de 2 000 lignes
  gardent un plafond à leur taille du jour, un nouveau fichier au-delà de 2 000 lignes est
  refusé ; une découpe fait baisser le plafond (`python scripts/quality_baselines.py update`).
- **Les handlers de worktree sont répartis par groupe** (F130). `worktree-handlers.ts` passe de
  3 629 à 1 216 lignes : le diff, la fusion, les fichiers, la création de PR et la preuve
  visuelle ont chacun leur module. Aucun changement de comportement.
