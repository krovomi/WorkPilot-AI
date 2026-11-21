---
section: 🐛 Corrections
---

- **Le démarrage ne reste plus bloqué sur un trousseau Linux verrouillé.** Sous WSL ou en SSH, la
  fenêtre de déverrouillage de GNOME Keyring peut s'afficher vide, et l'app l'attendait sans fin.
  WorkPilot AI ne choisit plus un trousseau verrouillé, et n'attend jamais plus de 5 secondes une
  réponse du trousseau : il démarre sans lui, garde les clés déjà chiffrées telles quelles et la
  bannière dit de déverrouiller le trousseau puis de redémarrer.
