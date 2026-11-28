---
section: ✨ Nouveautés
---

- **La page de santé, les métriques Prometheus et les traces du serveur** (mode serveur).
  `GET /admin/platform/health`, pour les administrateurs de la plateforme, dit pourquoi le
  serveur va bien ou non : base et révision du schéma, espace disque des clones et de la base, file des runs et des jobs, version, isolation des runs (Landlock) et tâches
  périodiques. `GET /metrics` sert les mêmes chiffres et des comptes par organisation au format
  Prometheus, à un collecteur qui envoie `WORKPILOT_METRICS_TOKEN` (404 sans lui). Avec
  `AUTO_CLAUDE_OTEL_ENDPOINT`, chaque requête devient un span OpenTelemetry nommé d'après sa
  route. Aucun ne nomme une personne, un projet ni un chemin.
