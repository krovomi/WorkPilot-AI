---
section: 🐛 Corrections
---

- **Un fichier créé par une tâche mais jamais commité apparaît dans « Fichiers modifiés » et n'est plus perdu à la fusion.** La liste ne lisait que les commits de la branche : un fichier que l'agent avait créé sans le commiter donnait « 0 files changed », et la fusion le laissait dans le worktree. La vue compare maintenant le worktree lui-même avec la base (fichiers commités, modifiés et non suivis), une erreur git s'affiche comme une erreur au lieu d'une liste vide, et la fin du build comme la fusion commitent ce que l'agent a laissé en attente.
