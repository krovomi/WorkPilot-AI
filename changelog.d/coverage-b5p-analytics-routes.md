---
section: 🧹 Maintenance
---

- **API locale** : des routes HTTP que plus rien n'appelait sont retirées. Les analytics
  (`/analytics/*` et leur repli vide) : le tableau de bord Analytics est construit par
  l'application depuis les relevés du projet, et la base des analytics reste, écrite par les builds
  et lue par les estimations et la santé des agents. L'état des sous-systèmes
  (`/api/router/config`, `/api/local-models/status`, `/api/costs/*`, `/api/scheduler/jobs`,
  `/api/auto-detect/status`) et l'état du nettoyage des watermarks (`/api/watermarks/status`),
  qu'aucune vue ne lisait.
- **API locale, filets de test** : les routes de la santé des agents, de la dérive d'architecture,
  de l'i18n Auto-Scaler, du pair programming et du journal d'audit sont couvertes à 100 %, les
  branches qu'aucune requête ne pouvait atteindre étant retirées.
