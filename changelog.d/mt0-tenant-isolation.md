---
section: 🔒 Sécurité
---

- **Mode serveur : le flux en direct s'arrête au tenant.** Un canal du serveur de streaming ne
  s'ouvre qu'aux membres de son projet, dans l'organisation où ils agissent ; seuls les jetons
  de service publient, et le jeton d'un run n'ouvre que le canal de ce run. Des réglages serveur
  illisibles laissent le serveur fermé.
- **Mode serveur : un run démarre avec un environnement construit.** Plus aucune variable propre
  au serveur (clé des jetons, clé des secrets, base de données, mail) n'arrive à un agent ; un
  test refuse toute nouvelle variable du serveur qui ne serait pas classée.
