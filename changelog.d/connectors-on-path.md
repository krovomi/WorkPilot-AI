---
section: 🐛 Corrections
---

- **Mistral, DeepSeek et Grok fonctionnent aussi en mode développement et sur un serveur** (F174).
  Les fonctions qui passent par ces providers (Arena, traduction, appels ponctuels), Jira et
  Azure DevOps échouaient sur « No module named 'src' » hors de l'app installée.
