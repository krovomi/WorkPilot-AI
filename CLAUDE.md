# CLAUDE.md

Claude Code ne lit pas `AGENTS.md` de lui-même : ce fichier l'importe, avec le noyau normatif et
les règles de sécurité, chargés dans chaque session. Les autres harnesses lisent `AGENTS.md`
directement ; rien ici ne leur est propre, donc rien ne leur manque.

@AGENTS.md
@docs/CLAUDE.md
@docs/rules/security.md

## Chargé à la demande

- Chaque dossier qui a un `AGENTS.md` a un `CLAUDE.md` voisin qui l'importe ; Claude Code le
  charge dès qu'il lit un fichier de ce dossier.
- `apps/backend/CLAUDE.md` ajoute `docs/rules/backend.md`, `apps/frontend/CLAUDE.md` ajoute
  `docs/rules/frontend.md`.
- `docs/rules/workflow.md` (commandes, hooks, CI, release) et `docs/architecture/` se lisent
  quand la tâche les concerne.

## Précédence

`docs/CLAUDE.md` et `docs/rules/` sont normatifs ; les `AGENTS.md` sont des index de navigation.
Quand ils divergent, la règle gagne et l'index est le fichier à corriger.
