---
section: ✨ Nouveautés
---

- **Vagues d'exécution : merge de test, reprise après redémarrage, zones fragiles** (#358, lot 2).
  Deux specs d'une même vague qui partagent des fichiers sous la tolérance et ont chacune un
  worktree passent par un merge de test (`git merge-tree`, sans toucher aux worktrees ni aux
  branches) : un vrai conflit les place dans des vagues différentes et la vue dit sur quels
  fichiers. L'exécution « dans l'ordre optimal » est enregistrée dans le `.workpilot/` du projet à
  chaque étape : après un redémarrage, la vue propose de la reprendre ou de l'abandonner. Les
  fichiers que l'historique git modifie souvent ensemble (un dans chaque spec) s'ajoutent au score,
  avec une option pour les désactiver. Toutes les stacks, aucun modèle appelé.
