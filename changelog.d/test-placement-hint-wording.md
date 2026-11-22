---
section: 🐛 Corrections
---

- **Les réglages « Général » d'un projet sont rangés par étape.** Après le dépôt et l'agent, ils
  suivent l'ordre où une tâche se construit : « Avant le code » (découpage, tests d'intégration
  d'abord), « Pendant le code » (TDD), « Avant la revue » (boucle de vérification, où tournent les
  longues suites de tests, revue croisée), puis l'environnement du worktree et les notifications.
  Le réglage des longues suites s'explique en mots plus simples.
