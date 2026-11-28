---
section: 🐛 Corrections
---

- **Le choix du modèle d'une phase liste tous les modèles d'OpenCode, pi, Antigravity et Gemini CLI.** La liste vient du CLI lui-même (`opencode models`, `pi --list-models`, `agy models`), donc des fournisseurs connectés dans ce CLI ; Gemini CLI reprend les modèles Gemini du catalogue Google. Avant, la liste ne montrait que le modèle déjà choisi.
- **GitHub Copilot ne propose plus que les modèles que ce compte peut appeler.** La liste du compte n'est plus complétée par la liste livrée, un modèle que Copilot ne sert pas sur `/chat/completions` en est retiré, et un refus `model_not_available_for_integrator` bascule la phase sur un modèle servi au lieu de l'arrêter.
