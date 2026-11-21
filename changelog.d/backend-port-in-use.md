---
section: 🐛 Corrections
---

- **`pnpm run dev` ne casse plus sur « Address already in use »** : quand un backend WorkPilot
  tourne déjà sur le port 9000 (lancement précédent resté ouvert, ou celui que l'app a démarré
  pendant l'installation des dépendances), il est réutilisé avec un message clair au lieu de faire
  échouer la commande. Un port pris par un autre programme est nommé, avec la commande qui le
  montre sur Windows, macOS, Linux et WSL. Côté app, un backend qui perd le port au profit d'un
  autre backend ne déclenche plus la boîte d'erreur, et la sortie du backend lancé par l'app est
  lue en continu pour qu'il ne se bloque plus sur ses propres logs.
