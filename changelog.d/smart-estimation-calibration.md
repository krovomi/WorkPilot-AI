---
section: ✨ Nouveautés
---

- **Smart Estimation apprend chaque dépôt** (#367) : à chaque fusion, l'estimation d'une spec est
  comparée à ce qu'elle a réellement consommé (coût, tokens, itérations de QA, fichiers modifiés),
  quel que soit le provider. Les estimations suivantes en tirent un facteur par dépôt et par
  catégorie (correction de bug, infrastructure, frontend, backend, fonctionnalité), affiché en
  fourchette avec sa confiance, un détail par dimension (algorithmique, intégration, risque de
  conflit, tests), des alertes quand le dépôt s'écarte du générique, la comparaison des providers
  et la précision des estimations passées. « Ajuster l'estimation » garde votre propre score,
  « Réinitialiser la calibration » repart des chiffres génériques après une refonte. Aucune durée
  n'est estimée.
