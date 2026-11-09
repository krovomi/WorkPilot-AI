---
section: ✨ Nouveautés
---

- **Les worktrees des cartes terminées ne remplissent plus le disque** (F180). Quand la PR d'une
  carte est fusionnée sur la forge (GitHub, GitLab, Azure DevOps), la carte passe « Terminé » et
  son worktree et sa branche locale sont supprimés. Le bouton « Purger » du Kanban montre la place
  occupée par les worktrees des cartes terminées, archivées ou abandonnées et les supprime. Un
  worktree avec des modifications non commitées n'est jamais supprimé.
