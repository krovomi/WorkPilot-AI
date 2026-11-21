---
section: ✨ Nouveautés
---

- **Mode serveur : une carte critique est approuvée par plusieurs personnes.** Une carte est
  `low`, `medium` ou `high` ; l'opérateur dit combien d'approbations il faut à chaque niveau
  (`WORKPILOT_APPROVAL_QUORUM`) et quels rôles doit tenir l'un des approbateurs
  (`WORKPILOT_APPROVAL_ROLES`). Un approbateur règle la criticité d'une carte ; l'évaluation de la
  spec peut seulement la relever. Modifier la spec ou le plan annule les approbations données ; le
  build ne démarre qu'une fois la carte approuvée, et l'app dit où en sont les approbations.
- **Mode serveur : un approbateur prête son approbation sur un projet** à un collègue, pour 90
  jours au plus (absence, astreinte) : le collègue approuve au nom de l'approbateur, sans pouvoir la
  prêter à son tour. Approbations, criticités et délégations entrent au journal d'audit de
  l'organisation.
