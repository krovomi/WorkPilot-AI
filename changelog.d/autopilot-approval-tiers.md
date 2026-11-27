---
section: ✨ Nouveautés
---

- **Le pilote de pile pose le niveau de validation de chaque PR de WorkPilot.** Avant de fusionner
  une PR verte vers `develop`, il ajoute le label `niveau:N0` à `niveau:N3`. Par défaut il ne fait
  qu'observer et fusionne comme avant ; avec la variable de dépôt `APPROVAL_TIERS=enforce`, les PR
  N2 et N3 attendent qu'une personne pose le label `approuvé`.
