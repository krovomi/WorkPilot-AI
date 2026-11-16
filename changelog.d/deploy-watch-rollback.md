---
section: ✨ Nouveautés
---

- **Surveillance après déploiement et rollback** : un pipeline lancé depuis les déclencheurs
  CI/CD est suivi pendant une fenêtre d'observation (15 minutes par défaut). Le health check et
  les métriques Prometheus de `.workpilot/deploy-monitors.yaml` (taux d'erreur, latence, débit ou
  métrique métier) sont comparés à leur niveau d'avant le déploiement ; deux mesures critiques
  d'affilée donnent le verdict « critique ». Le rollback est alors proposé sur la page, ou lancé
  tout seul si le réglage le demande : GitHub Actions relance la dernière exécution réussie,
  Azure Pipelines redéploie son commit ; GitLab CI et Jenkins donnent le lien de la dernière bonne
  exécution. Une migration de base de données dans le changement (Alembic, Django, Rails,
  Laravel, Entity Framework, Flyway, Liquibase, Prisma, Ecto, Room…) bloque le rollback
  automatique et est nommée.
