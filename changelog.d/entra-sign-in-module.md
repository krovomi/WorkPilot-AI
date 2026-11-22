---
section: 🛠️ Qualité
---

- **Connexion Microsoft Entra ID du mode serveur dans un module à elle** : le parcours PKCE de
  l'app de bureau quitte le fichier des handlers pour `main/entra-sign-in.ts`, testé de bout en
  bout contre une redirection locale. Il vérifie la forme des identifiants du serveur avant de
  construire l'adresse de connexion, envoie un `nonce` que le jeton rendu doit reprendre, et
  ouvre le navigateur par `openExternalUrl`, comme les autres liens de l'app.
