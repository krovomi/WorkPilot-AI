---
section: ✨ Nouveautés
---

- **Vagues d'exécution entre specs** (#358, lot 1) : dans Mission Control, les specs du backlog et
  de la file sont regroupées en vagues qui ne partagent aucun fichier, d'après leurs plans et ce
  que leurs worktrees ont déjà modifié, quelle que soit la langue (un manifeste de dépendances ou
  un lockfile pèse plus). Plan vague par vague, ordre de merge, paires les plus risquées, cycles
  de dépendances signalés, dérive d'une spec hors de son plan. « Exécuter dans l'ordre optimal »
  lance chaque vague par le démarrage habituel des tâches (chaque tâche avec son provider), dans
  la limite des tâches parallèles du projet, et replanifie le reste à chaque vague. Aucun modèle
  n'est appelé.
