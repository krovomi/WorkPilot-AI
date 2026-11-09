---
section: 🐛 Corrections
---

- **La barre « Commande rapide » du Kanban marche avec un abonnement Claude et avec tous les
  providers** (F181). Elle échouait sur « No OAuth token found » avec un abonnement Claude
  classique et ignorait le provider choisi : la commande tournait dans le serveur backend, qui n'a
  ni la connexion du profil Claude ni le provider de l'app. Elle tourne maintenant avec le
  provider sélectionné (Claude Code, Codex, Copilot, Gemini, OpenCode, Mistral, Ollama…) et, comme
  les autres pages, sur une branche de revue : ce que la commande écrit attend sur une carte en
  Revue humaine, d'où l'on ouvre la PR, au lieu d'arriver dans le dossier du projet.
