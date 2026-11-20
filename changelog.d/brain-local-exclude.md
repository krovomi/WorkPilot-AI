---
section: 🐛 Corrections
---

- **Cerveau partagé sur un dossier en lecture seule** : quand le `.gitignore` du vault ne peut
  être ni lu ni écrit, les fichiers propres à la machine (corbeille, conflits, caches) sont
  exclus par le fichier d'exclusion local du dépôt, et une synchronisation ne les envoie plus.
- **Garde-fou des worktrees sur Windows** : un worktree à la racine d'un disque désigne la
  racine du disque (`D:\`) comme dossier interdit, et non le dossier courant de ce disque.
