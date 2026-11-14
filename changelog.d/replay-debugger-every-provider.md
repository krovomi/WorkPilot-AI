---
section: 🐛 Corrections
---

- **L'Agent de Replay et l'Historique des sessions joignent le backend local**, en développement comme dans l'application installée : ils passaient par une adresse vide côté interface et tombaient sur la page du serveur Vite, d'où « Le backend local de WorkPilot n'a pas répondu ». Le Time travel visait aussi un port où rien n'écoute (8321).
- **Chaque session d'agent est enregistrée pour le Replay, quel que soit le fournisseur** : le planificateur et le codeur (Claude compris) n'enregistraient rien, et l'enregistrement du chemin Claude direct s'arrêtait dès son démarrage.
- **Le Débogueur d'agent liste chaque exécution dès qu'elle démarre** et ses points d'arrêt mettent aussi en pause OpenAI, Copilot, Windsurf, Gemini, Mistral, Ollama et les autres fournisseurs dont WorkPilot exécute les outils (les agents en CLI, Codex, OpenCode, pi, Antigravity, exécutent les leurs et restent hors de portée).
