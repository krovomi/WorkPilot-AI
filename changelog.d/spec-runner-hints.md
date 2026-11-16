---
section: 🐛 Corrections
---

- **Un build bloqué faute d'approbation indique une commande qui existe.** Le message renvoyait
  vers `review.py`, qui n'existe plus : il propose maintenant la revue de la tâche dans l'app, ou
  `runners/spec_runner.py --continue <spec>` pour la faire dans le terminal. Lancé depuis le backend
  de WorkPilot, le runner de spec trouve le dépôt autour au lieu d'écrire la spec dans le backend ;
  un fichier de tâche illisible est signalé au lieu de planter, et `--provider Anthropic` prend le
  même modèle que `anthropic`.
