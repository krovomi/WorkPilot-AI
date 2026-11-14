---
section: 🐛 Corrections
---

- **REA trouve le Node.js de nvm, fnm, Volta, mise ou asdf**. Quand le Node.js du PATH est trop
  ancien ou absent, WorkPilot prend la version la plus récente qu'un gestionnaire de versions a déjà
  installée et que REA accepte, préversions comprises (27.0.0-alpha). Sous WSL, l'app héritait de
  l'alias par défaut de nvm (26.10.0) alors que le terminal était passé en 27 : le panneau REA
  disait « Node.js trop ancien ». Le bouton d'installation passe alors par le npm de ce Node.js.
- **Le lien « Voir la documentation de REA » s'ouvre sous WSL**. Les liens web passent d'abord par
  Windows quand l'app tourne sous WSL, où ni `xdg-open` ni `wslview` ne sont installés ; un lien qui
  ne s'ouvre toujours pas le dit sous le bouton au lieu de ne rien faire.
