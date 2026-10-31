---
section: 🐛 Corrections
---

- **« Ouvrir dans Obsidian » ouvre de nouveau la note**. Sous WSL, le lien `obsidian://` partait
  vers `xdg-open` côté Linux, qui ne connaît pas Obsidian, avec un chemin `/home/…` ou `/mnt/c/…`
  qu'Obsidian pour Windows n'aurait pas compris : il est maintenant réécrit avec le chemin Windows
  (`C:\…` ou `\\wsl.localhost\<distro>\…`) et confié à Windows. Sur Linux, le lien n'est plus
  passé à un navigateur. Et quand rien ne s'ouvre, une notification le dit au lieu d'un bouton muet.
