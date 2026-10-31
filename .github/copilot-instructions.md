<!-- COPILOT:HEADER -->
# Copilot — WorkPilot AI

Les règles communes à tous les agents sont dans [`AGENTS.md`](../AGENTS.md) (racine et dossiers),
que Copilot lit aussi : elles ne sont pas répétées ici. Les conventions par dossier se chargent
seules par `applyTo` depuis [`instructions/`](instructions/) ; BMAD est dans
`instructions/bmad.instructions.md`, chargé seulement sous `_bmad/`.

- Fichier de plus de 1 000 lignes : `grep` puis `view` sur une plage, jamais en entier.
- Les règles normatives ([`docs/rules/`](../docs/rules/)) priment sur ce fichier et sur les `.instructions.md`.
<!-- /COPILOT:HEADER -->
