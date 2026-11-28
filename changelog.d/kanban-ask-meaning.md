---
section: ✨ Nouveautés
---

- **« Interroger le tableau » comprend le sens, d'une langue à l'autre.** Quand un modèle
  d'embeddings est là, les tickets sont aussi classés par le sens de la question : « admin page
  review » trouve « Revisión del panel de administración » sans un mot en commun, même sans
  réponse de l'IA. Le modèle de cet ordinateur d'abord (Ollama, LM Studio, par exemple `bge-m3`),
  sinon l'API d'embeddings du provider choisi (OpenAI, Mistral, Google, Hugging Face) ; jamais
  d'API sous le mode hors-ligne strict. Le réglage **Par le sens** du panneau choisit Auto, Cet
  ordinateur seulement ou Désactivé. Les vecteurs restent sur cet ordinateur, pour qu'une question
  suivante n'envoie que les tickets qui ont changé.
