---
section: ✨ Nouveautés
---

- **Auto-guérison proactive : tendances de risque** (#370). Chaque scan garde un instantané par
  fichier (`.workpilot/self-healing/health_history.sqlite`, un par jour, 120 jours) ; chaque
  fichier reçoit une trajectoire (stable, montée lente, montée rapide, amélioration), avec sa
  courbe, ce qui l'explique (complexité, churn) et un drapeau quand il entre dans la liste
  chaude. Les dossiers dont la plupart des fichiers montent ensemble sont signalés.
- **Production : un incident par bug** (#372). Une empreinte (type d'erreur normalisé, fichier
  et fonction du frame le plus interne du dépôt, service, version ; sans numéros de ligne ni
  identifiants) regroupe les rapports de Sentry, Datadog, PagerDuty… en un seul incident et une
  seule tentative de correction. Les commits suspects depuis la dernière release sont classés,
  et les incidents d'un même commit en héritent la priorité la plus haute.
- **CI/CD : bisect assisté** (#375). Quand le dernier commit n'est probablement pas le coupable
  (diff minuscule, test ancien, dépendance modifiée), les tests en échec sont rejoués entre le
  dernier commit vert et le commit en échec dans un worktree temporaire, borné en exécutions et
  en temps, sans toucher la copie de travail ; le premier commit fautif et son diff vont au
  correcteur. Bouton « Bisect » sur chaque incident CI/CD, réglage `autoBisect`.
