---
section: 🐛 Corrections
---

- **Revues et commentaires GitHub longs sous Windows** : le texte d'une revue, d'un commentaire, d'une issue créée ou d'un message de merge passe maintenant à `gh` par l'entrée standard (`--body-file -`) plutôt que sur la ligne de commande, que Windows limite à 32 767 caractères et qu'un lanceur `.cmd` coupe au premier saut de ligne.
