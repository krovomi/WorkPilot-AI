---
section: 🐛 Corrections
---

- **Prédicteur de conflits** : chaque branche est comparée à la branche dont elle part
  (`DEFAULT_BRANCH`, sinon `main`, `master` ou `develop`) et seulement pour ce qu'elle a changé
  depuis. Un dépôt sur `master` ne donnait plus aucun résultat, et ce que la base avait changé
  après le départ des branches apparaissait comme un conflit entre elles. L'alias
  `origin/HEAD` n'est plus pris pour une branche, et un fichier déjà en conflit n'est plus
  répété parmi les zones à risque.
