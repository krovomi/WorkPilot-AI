---
section: 🐛 Corrections
---

- **Source d'une fonctionnalité importée dans la feuille de route** : un outil que l'app ne connaît pas affiche « Externe » sur le badge et son propre nom dans l'infobulle, au lieu de « Importé depuis Externe ».
- **Tests réalignés après les fusions** : le faux détecteur de bots de la revue de suivi connaît `mark_review_finished`, le test du sélecteur d'usage choisit le fournisseur inconnu par le stockage local, le test de dictée rend un arrêt avec `flush`, et le test des cartes de la feuille de route suit la carte telle qu'elle est sur develop (nom de phase entier tronqué par le style, colonne surlignée pendant un glisser).
