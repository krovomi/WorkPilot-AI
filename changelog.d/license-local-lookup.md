---
section: 🐛 Corrections
---

- **Licences lues sur les copies installées** : la recherche ne lit que dans le dossier qu'elle
  parcourt (le `node_modules` du projet, ou le cache de paquets de l'écosystème), quel que soit
  le nom de la dépendance ; un `package.json` installé d'une autre forme qu'un objet ne fait plus
  échouer l'analyse.
