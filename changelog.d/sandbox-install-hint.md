---
section: 🐛 Corrections
---

- **L'alerte « commandes non isolées » dit comment y remédier**. Quand `socat` (exigé par le bac
  à sable de Claude Code sous Linux et WSL) ou `bubblewrap` manque, la raison affichée sur la
  carte et dans le fil de la tâche donne la commande d'installation du gestionnaire de paquets
  trouvé (`sudo apt install socat`, dnf, pacman, zypper, apk), à lancer avant de relancer la tâche.
