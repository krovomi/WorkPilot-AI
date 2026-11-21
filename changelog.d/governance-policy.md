---
section: ✨ Nouveautés
---

- **Gouvernance des agents dans `workpilot.policy.yaml`** (#353) : la politique versionnée du dépôt fixe les heures où les agents travaillent (fuseau explicite, plages de nuit, jours), les fichiers qu'ils ne touchent jamais et ceux qui attendent une revue, et un budget de jetons par heure pour tout le projet, sur tous les fournisseurs. Hors des heures ou au budget atteint, la tâche se met en pause et sa carte dit pourquoi ; un fichier invalide refuse toute écriture et toute commande. Chaque décision (refus, revue, approbation, avertissement, hors horaires, budget atteint, politique invalide) est inscrite dans un journal d'audit borné, que Réglages → Garde-fous affiche en lecture seule avec la politique active et ses erreurs, et exporte en CSV ou JSON.
