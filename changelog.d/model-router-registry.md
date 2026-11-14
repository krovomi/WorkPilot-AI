---
section: 🐛 Corrections
---

- **Routage adaptatif des modèles à jour et fidèle au provider** : les modèles proposés viennent
  du registre (Haiku, Sonnet et Opus 5.5, et les modèles actuels d'OpenAI, Gemini, Mistral,
  DeepSeek, Grok, Copilot, Ollama) au lieu d'identifiants périmés. Une tâche ne se voit plus
  suggérer le modèle d'un autre provider : la suggestion reste sur le provider de la phase, et
  un agent CLI qui choisit son modèle n'en reçoit aucun. Copilot et les modèles locaux sont
  présentés sans coût par token, la raison du choix est écrite dans la langue de l'app, et le
  type de tâche se choisit dans une liste.
