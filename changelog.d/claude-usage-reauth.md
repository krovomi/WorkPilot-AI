---
section: 🐛 Corrections
---

- **Usage du compte Claude sélectionné** : quand la connexion du compte actif a expiré mais que son ancien jeton restait dans le trousseau, la popin d'usage disait « ce fournisseur ne publie pas de quota » au lieu de proposer de reconnecter le compte. Elle propose maintenant « Reconnecter », et le repli par la commande `claude usage` lit le compte sélectionné (son dossier), jamais le compte par défaut, ni un 0 % inventé quand la commande ne donne aucun chiffre.
