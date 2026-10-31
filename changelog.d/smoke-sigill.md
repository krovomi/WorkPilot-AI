---
section: 🧪 Filets de test
---

- **Le smoke test Electron ne plante plus au hasard en fin de course** (F134). Il quittait l'app
  sans son nettoyage pendant que les DevTools s'ancraient dans la fenêtre fermée (SIGILL) ; il
  quitte maintenant comme un utilisateur, sans DevTools. Quitter l'app pendant l'installation
  des dépendances Python arrête aussi `pip` au lieu de le laisser tourner.
