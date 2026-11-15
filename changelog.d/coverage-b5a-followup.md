---
section: 🧹 Maintenance
---

- **Plancher de couverture backend à 76 %** : la CI refuse désormais une couverture pytest sous
  76 % (`apps/backend` et `src/`), au lieu de 75 %. Le test du chargement d'une configuration
  de providers dont les droits ne peuvent pas être resserrés n'écrit plus de fichier lisible
  par le groupe.
