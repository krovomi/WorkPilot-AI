---
section: 🐛 Corrections
---

- **La liste des modèles Ollama ne plante plus quand aucun modèle n'est installé.** Ollama répond alors `"data": null` au lieu d'une liste vide, ce qui faisait échouer le catalogue des modèles (erreur 500) ; le sélecteur affiche désormais une liste vide. Les autres catalogues (Anthropic, OpenAI, Google, Mistral, DeepSeek, Grok, LM Studio) et les écrans de modèles locaux tolèrent la même réponse.
