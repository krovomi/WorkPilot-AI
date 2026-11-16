---
section: 🐛 Corrections
---

- **Le chat Insights répond sur le provider du projet, et dit quand il ne le peut pas.** Un échec
  chez Copilot, OpenAI ou un autre provider ne relance plus la question sur Claude en silence, et
  une connexion manquante n'est plus remplacée par un texte d'excuse affiché comme une réponse :
  l'app montre la raison. Avec Claude, l'outil en cours s'efface quand il a fini au lieu de rester
  affiché jusqu'à la fin de la réponse.
