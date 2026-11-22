---
section: 🧪 Filets de test
---

- **La matrice des routes du serveur nomme les quatre routes de gouvernance** : lecture du
  panneau (`audit.read`), export de la piste d'audit (`audit.export`), réponse à une demande
  d'approbation (`review.approve`) et arrêt des agents (`agent.cancel`), chacune portée par le
  projet. Le test des groupes vérifie aussi qu'une lecture que le rôle contributeur ne détient
  pas, comme l'export, est refusée pour cette permission et seulement elle.
