---
section: ✨ Nouveautés
---

- **Le serveur compte les tokens de chaque run** : chaque session d'agent d'un run ou d'un job
  du serveur (tous providers) envoie au serveur ses tokens, son provider, son modèle et son coût,
  rangés avec la personne qui l'a lancé, son projet et son organisation. Le budget mensuel de
  tokens des quotas compte enfin cette consommation (il restait à 0 et ne bloquait rien), la Vue
  d'ensemble et l'onglet Quotas l'affichent, et un run note son provider.
