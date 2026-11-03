---
section: ✨ Nouveautés
---

- **Re-revue QA par delta**. Après un rejet, la passe QA suivante vérifie d'abord ce que le fixer
  a changé (lu dans git), les issues encore ouvertes et les tests des fichiers touchés : si une
  issue reste ouverte, elle rejette tout de suite au lieu de relancer l'environnement et toutes
  les suites. La passe qui approuve reste une revue complète. Pour tous les providers ;
  `WORKPILOT_QA_RECHECK=0` la désactive.
