# Documentation de WorkPilot AI

Une seule racine de documentation : ce dossier. Chaque fait vit à un seul endroit ; les autres
fichiers y renvoient.

## Pour qui, quoi

| Dossier / fichier | Contenu | Statut |
|---|---|---|
| [`CLAUDE.md`](CLAUDE.md) | le noyau des règles : règles critiques, index des règles et des justifications | normatif |
| [`rules/`](rules/) | règles par thème : [sécurité](rules/security.md), [backend](rules/backend.md), [frontend](rules/frontend.md), [workflow](rules/workflow.md) | normatif |
| [`architecture/`](architecture/) | pourquoi chaque feature est construite ainsi, une feature par fichier | référence |
| [`SECURITY.md`](SECURITY.md) | politique de sécurité : versions supportées, signaler une vulnérabilité | public |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | contribuer : installation, style, tests, branches, PR | humains |
| [`CONFIGURATION.md`](CONFIGURATION.md) | providers, résolution des identifiants, variables d'environnement | référence |
| [`CLI-USAGE.md`](CLI-USAGE.md) | utilisation en terminal et en CI | guide |
| [`MODEL_CATALOG.md`](MODEL_CATALOG.md) | mettre à jour le catalogue de modèles livré | guide |
| [`RELEASE.md`](RELEASE.md) | publier une version | mainteneurs |
| [`linux.md`](linux.md), [`windows-development.md`](windows-development.md) | notes par plateforme | guide |
| [`providers/`](providers/) | architecture détaillée des providers Claude Code et GitHub Copilot | référence |
| [`features/`](features/), [`integrations/`](integrations/) | une feature ou une intégration optionnelle expliquée à l'utilisateur (JEV, [pi](integrations/pi.md)…) | guide |
| [Backlog produit](https://github.com/krovomi/WorkPilot-AI/issues/343) | idées et pistes produit : une issue par piste, sous l'issue parente #343 | backlog (issues) |
| [`audit/`](audit/) | l'atlas d'architecture (`WorkPilot-architecture.html`, vue « Pour tous » lisible sans prérequis technique, feuille de route par type de tâche) et le cahier de nettoyage, avec un fichier par constat depuis F113 (`findings/`) et par annexe (`annexes/`) ; un historique, pas une règle | atlas · historique |
| [`validation/`](validation/) | captures de validation manuelle | preuves |

Les instructions des agents de code se répartissent ainsi : [`../AGENTS.md`](../AGENTS.md) (index lu
par tous les harnesses), [`../CLAUDE.md`](../CLAUDE.md) (l'import pour Claude Code), un `AGENTS.md`
par dossier qui en a besoin, et `.github/copilot-instructions.md` avec
`.github/instructions/*.instructions.md` pour Copilot.

## Maintenir cette documentation

- **Une règle** va dans le fichier de `rules/` de son thème — ou dans `CLAUDE.md` si elle vaut
  partout. Jamais dans un `AGENTS.md`, qui ne fait que pointer.
- **Une justification** (« pourquoi c'est construit ainsi ») va dans `architecture/<feature>.md`,
  avec une ligne dans la table de `CLAUDE.md`.
- **Un nouvel index local** `AGENTS.md` vient avec un `CLAUDE.md` voisin qui contient `@AGENTS.md`,
  et une ligne dans la table « Index locaux » de `../AGENTS.md`.
- **Pas de fichier d'instructions au-delà de 200 lignes** ; au-delà, on découpe par thème.
- Un chemin cité doit exister, un lien doit résoudre : `tests/test_docs_context.py` le vérifie.
- Un compte rendu de refactoring ou de session va dans le message de commit ou la PR, pas dans un
  fichier `*_SUMMARY.md`.
