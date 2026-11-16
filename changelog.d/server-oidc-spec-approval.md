---
section: ✨ Nouveautés
---

- **Mode serveur : connexion par n'importe quel fournisseur OpenID Connect** (Okta, Google,
  Keycloak, Auth0…), à côté de Microsoft Entra. L'opérateur donne l'émetteur et l'identifiant du
  client (`WORKPILOT_OIDC_ISSUER`, `WORKPILOT_OIDC_CLIENT_ID`) ; l'écran de connexion de l'app
  propose « Se connecter avec {nom} ». Une adresse ne relie un compte existant que si le
  fournisseur l'a vérifiée.
- **Mode serveur : une spec est approuvée par une autre personne que l'auteur de la carte** quand
  quelqu'un d'autre sur le projet peut approuver. `WORKPILOT_SELF_APPROVAL` règle ce choix
  (`when-alone` par défaut, `deny`, `allow`).
