---
section: 🐛 Corrections
---

- **« Copier le chemin » colle directement dans l'Explorateur Windows sous WSL** : le studio de
  tests, les worktrees et les réglages du dépôt copient `\\wsl.localhost\<distro>\…` (ou `C:\…`
  sous `/mnt/c`) au lieu du chemin Linux.
- **La liste des tests générés reste lisible** : chaque test garde sa hauteur au lieu d'être écrasé
  quand la liste dépasse le panneau, et nomme le fichier ciblé au lieu de son chemin complet.
