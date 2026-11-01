---
section: ✨ Nouveautés
---

- **Les CLI manquants s'installent en un clic.** Dans la barre latérale, « Outils CLI », OpenCode, Antigravity, pi et Gemini CLI affichent un bouton « Installer » quand ils ne sont pas trouvés : WorkPilot les télécharge et les installe avec la méthode officielle de l'éditeur (le paquet npm quand il existe et que Node.js est assez récent, sinon le script d'installation de l'éditeur), sous Windows, macOS et Linux, WSL compris. Sous Linux, un préfixe npm global non inscriptible est réessayé dans `~/.local`, et sous WSL un npm Windows (`/mnt/c/…`) n'est jamais utilisé. La connexion reste celle de chaque CLI : on se connecte une fois dans un terminal.
