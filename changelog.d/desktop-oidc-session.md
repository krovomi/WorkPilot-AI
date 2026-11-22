---
section: ✨ Nouveautés
---

- **L'app de bureau se connecte à un serveur d'équipe par n'importe lequel de ses fournisseurs
  d'identité, et montre comment la session a été ouverte** (#363). Le bouton Microsoft Entra ID
  passe désormais par le même flux OpenID Connect que Okta, Google Workspace, Keycloak ou Auth0
  (PKCE, `state` et `nonce`, retour sur la boucle locale), avec les mêmes contrôles. Une nouvelle
  page des réglages, « Ma session sur le serveur », dit qui est connecté, par quoi (mot de passe,
  Entra, fournisseur et hôte de son émetteur, invitation) et depuis quand, et permet de se
  déconnecter ; le serveur le donne par `GET /auth/me/session` et garde dans son journal le
  fournisseur de chaque connexion.
