---
section: 🐛 Corrections
---

- **Le Contrôle de Mission fait vraiment travailler ses agents** (F183). Un agent lancé n'appelait
  aucun modèle et restait « running » à 0 token ; il répond maintenant avec le fournisseur et le
  modèle choisis (tous ceux qui ont un adaptateur, les CLI dans le projet ouvert), sa réponse
  s'affiche sur la carte avec ses tokens et son coût, et un échec dit pourquoi.
