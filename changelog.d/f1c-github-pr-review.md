---
section: 🐛 Corrections
---

- **Revue de PR GitHub plus fiable** : une revue qui échoue arrête le spinner de sa PR au lieu de
  le laisser tourner ; annuler une revue arrête aussi les processus qu'elle a lancés, et la
  relance d'une revue n'est plus effacée par la fin de la précédente. Un check GitHub expiré
  compte comme un échec de CI, un dépôt configuré par son URL de clone fonctionne, un gros diff
  n'est plus coupé et deux commentaires publiés en même temps ne se mélangent plus. Les appels à
  `gh` ne bloquent plus la fenêtre, et les arguments de publication et de la mémoire des revues
  sont vérifiés dans le main. `pr-handlers.ts` passe de 2 153 à environ 800 lignes
  (`pr-review-run.ts`, `pr-freshness.ts`, `pr-review-memory.ts`), couverts à 100 %.
