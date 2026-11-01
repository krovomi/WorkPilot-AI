---
section: 🐛 Corrections
---

- **Les projets de l'ordinateur fonctionnent pendant la connexion à un serveur.** L'app lance
  toujours son backend local, et les outils propres à la machine (hooks, mémoire, notifications,
  boucle d'apprentissage) lui parlent au lieu d'appeler le serveur.
