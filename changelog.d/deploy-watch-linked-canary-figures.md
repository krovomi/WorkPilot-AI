---
section: ✨ Nouveautés
---

- **Rollback coordonné des services liés** : sur la page CI/CD d'un projet, on choisit les
  autres projets de l'app qui reviennent en arrière avec lui (le frontend avec son backend).
  Quand son rollback démarre, chacun revient, avec ses propres réglages CI/CD, là où il était à
  la dernière bonne exécution du premier ; une migration ou un fournisseur sans rollback par API
  le laisse à une personne, et la page dit ce que chacun a fait. Le lien est gardé par l'app,
  jamais dans un dépôt.
- **Analyse canary** : une métrique de `.workpilot/deploy-monitors.yaml` peut porter une
  `canary_query` ; chaque mesure compare alors le canary au parc stable au même moment.
- **Grafana** rejoint Prometheus, Datadog, New Relic et CloudWatch comme source de métriques
  (URL, jeton de compte de service chiffré, uid de la source de données).
- **Chiffres de la surveillance**, calculés sur la machine : rollbacks automatiques et demandés
  par mois, délai entre la dégradation et le rollback (objectif : trois minutes), incidents
  évités, fausses alertes. Un mauvais verdict se juge sur la page (« fausse alerte » ou « vrai
  problème ») ; le rapport d'incident mène à Self-Healing et à la tâche dont la PR a été déployée.
