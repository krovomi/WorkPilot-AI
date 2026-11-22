---
section: ✨ Nouveautés
---

- **Connexions et présence sur le serveur d'équipe.** Une connexion refusée entre dans l'historique
  d'audit de l'organisation (`auth.login_failed`), avec sa méthode et sa raison (mot de passe
  faux, compte désactivé, compte inconnu, jeton du fournisseur refusé), jamais le mot de passe ni
  l'adresse tapée pour un compte inconnu ; chaque job lancé y entre aussi. Le serveur note le jour
  où chacun l'utilise, base des personnes actives par jour, semaine et mois et des comptes
  dormants de la future vue Usage. Consommation et présence s'effacent après
  `WORKPILOT_USAGE_RETENTION_DAYS` (365 jours par défaut). Ce qui est gardé, pour le registre
  RGPD : [`docs/server-usage-data.md`](docs/server-usage-data.md).
