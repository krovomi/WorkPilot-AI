---
section: 🐛 Corrections
---

- **`pnpm run dev` ne bute plus sur un port 9000 tenu par un autre programme.** Le backend et l'app
  passent ensemble au port libre suivant (9001 à 9020) et le disent ; l'app packagée fait de même.
  `BACKEND_PORT` dans `.env-files/.env` fixe un port, utilisé tel quel. Sous WSL en réseau
  `mirrored`, le message cite aussi les connexions mortes que la redirection de ports de VS Code
  laisse sur le port.
- **Plus d'avertissement « Unsupported platform » pour `@lydell/node-pty-darwin-arm64`** à
  l'installation sous Linux et Windows : la dépendance est optionnelle, installée sur macOS arm64
  seulement.
- **Un jeton Claude expiré demande la reconnexion dès le lancement d'un agent**, au lieu
  d'attendre le 401 de la tâche (fenêtre « Authentification requise », sauf si la bascule
  automatique de compte sur échec d'authentification est active).
