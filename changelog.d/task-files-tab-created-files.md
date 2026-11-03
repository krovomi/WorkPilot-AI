---
section: 🐛 Corrections
---

- **L'onglet « Fichiers » d'une tâche montre les fichiers qu'elle a créés ou modifiés.** Il ne listait que le dossier de spécification, et une tâche créée pendant la session n'en avait même pas le chemin : « Aucun fichier de spécification disponible » s'affichait alors que la tâche avait bien créé `test.txt`. Les fichiers de la tâche (créés, modifiés, supprimés, lus dans le worktree, ou dans le projet une fois fusionnés) viennent maintenant en tête, la spécification en dessous.
