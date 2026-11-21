---
section: ✨ Nouveautés
---

- **La surveillance de déploiement lit Datadog, New Relic et CloudWatch**, en plus de
  Prometheus : la source se choisit dans les réglages CI/CD, ses clés y restent chiffrées, et
  chaque métrique de `.workpilot/deploy-monitors.yaml` s'écrit dans le langage de la source.
  Un mauvais verdict part aussi sur **Slack**, par **e-mail** (SMTP) et, s'il est critique, sur
  **PagerDuty** pour la personne d'astreinte ; la page dit ce que chaque canal a reçu. Avec
  Jenkins, le commit déployé est lu dans le build : la migration bloque le rollback et la PR de
  revert s'ouvre, comme pour les autres fournisseurs.
