---
section: 🐛 Corrections
---

- **Revue IA des pull requests Azure DevOps** : la revue aboutit enfin. Elle échouait à chaque
  lancement et l'échec était enregistré comme une approbation ; une revue qui n'a pas pu tourner
  est désormais marquée en échec avec sa cause. L'app lit le résultat au lieu d'afficher
  « Failed to parse review result », le diff montre les lignes réellement modifiées au lieu d'un
  simple résumé par fichier, le contexte du projet est transmis au relecteur, et un verdict
  « bloqué » n'est plus adouci par des constats moins graves.
