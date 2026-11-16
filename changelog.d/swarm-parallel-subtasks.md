---
section: 🐛 Corrections
---

- **Le Mode Essaim construit vraiment les sous-tâches en parallèle.** Son réglage est désormais
  enregistré et transmis à chaque build : les sous-tâches que le plan permet de mener côte à côte
  tournent en même temps, chacune dans son propre worktree, et sont fusionnées dans la branche de
  la tâche après chaque vague ; une sous-tâche en conflit revient au codeur de la tâche. Les
  options « fusion assistée par IA » et « simulation », que rien n'appliquait, sont retirées.
