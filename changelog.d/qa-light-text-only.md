---
section: 🐛 Corrections
---

- **Une tâche qui ne crée qu'un fichier texte n'échoue plus en QA, et coûte beaucoup moins de
  jetons** (F133). « Créer toto.txt contenant OK » abandonnait après 3 passes : la barrière de
  couverture à 100 % rejetait chaque approbation, faute de couverture à mesurer sur un `.txt`.
  Quand git montre que seuls des fichiers texte ou de documentation ont changé, la QA fait
  désormais une revue légère (spec et diff dans le prompt, ni suites de tests, ni couverture,
  ni scan du dépôt), pour tous les providers. La QA complète ne cherche plus les failles que
  dans les fichiers modifiés (avant : `grep -r` sur tout le dépôt, `node_modules` compris), et
  le mode TDD ne fait plus écrire de test pour un fichier texte.
