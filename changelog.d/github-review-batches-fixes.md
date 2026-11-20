---
section: 🐛 Corrections
---

- **Lots d'issues GitHub enregistrés pour de bon** : les lots créés par le regroupement, ceux
  validés dans l'assistant et ceux qui passent en analyse sont maintenant écrits sur le disque
  (ils restaient en mémoire), et l'état des lots s'affiche au lieu d'échouer dès qu'un lot existe.
- **Revue de PR GitHub** : les réponses aux commentaires des outils d'IA sont publiées quand la
  publication automatique est activée (elles échouaient toutes), le suivi d'une revue interroge
  le dépôt configuré, et une revue ou un suivi terminé ne laisse plus la PR « en cours de revue »
  pendant trente minutes. La ligne de synthèse ne dit plus « tous les checks passent » quand la
  CI tourne encore, et un constat dont le titre parle de CI ou de conflit de merge reste compté
  comme un problème de code.
