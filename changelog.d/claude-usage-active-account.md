---
section: 🐛 Corrections
---

- **Pourcentages d'usage de Claude rétablis avec plusieurs comptes.** La popin d'utilisation lit
  le compte Claude actif, celui des tâches, et non plus le compte le moins utilisé (un compte tout
  juste ajouté passait devant). Quand la connexion de ce compte a expiré, elle propose de le
  reconnecter au lieu d'annoncer que le fournisseur ne publie pas de quota.
