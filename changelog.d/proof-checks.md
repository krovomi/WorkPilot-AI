---
section: ✨ Nouveautés
---

- **Vérification des preuves formelles.** Un projet qui garde des preuves (Dafny, Lean, Verus,
  F*…) déclare ses vérificateurs dans `[proofs]` de `.workpilot/worktree.toml`. Après
  l'approbation de la QA, ils tournent dans le worktree de la tâche : une preuve refusée renvoie
  le fixer avec la sortie du vérificateur. Nouvelle porte dure `proof-checks` sur les workflows
  qui écrivent du code ; un vérificateur absent ou hors délai donne « inconnu », jamais vert, et
  un projet sans preuve n'est pas concerné. La recette ne tourne qu'approuvée, depuis le projet,
  jamais depuis la branche de la tâche.
